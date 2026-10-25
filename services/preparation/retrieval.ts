/** Preparation-time retrieval only. No native actions or visitor-session work. */
import { createHash, randomUUID } from 'node:crypto';

export interface EvidenceDocument {
  id: string;
  text: string;
  metadata: Record<string, string> & {
    profile: string;
    app: string;
    app_version: string;
    kind: string;
    provenance: string;
  };
}
export interface EvidenceScope { profile: string; app: string; app_version: string; profile_revision?: string }
export interface RetrievalQuery extends EvidenceScope { query: string; topK?: number }
export interface RetrievedEvidence { document: EvidenceDocument; score: number }
/** This is a narrow SDK boundary, not a second product profile contract. */
export interface MossSessionLike {
  addDocs(documents: EvidenceDocument[]): Promise<{ added: number; updated: number }>;
  query(query: string, options: { topK: number; filter: { $and: Array<{ field: string; condition: { $eq: string } }> } }): Promise<{ docs: Array<{ id: string; score: number }> }>;
  close(): Promise<void>;
}
export interface MossClientLike {
  session(name: string, model: 'moss-minilm'): Promise<MossSessionLike>;
  close(): Promise<void>;
}
export interface PreparedEvidence {
  schemaVersion: 1;
  scope: EvidenceScope;
  query: string;
  preparedAt: string;
  retrieval: 'moss' | 'local-curated';
  corpusSha256: string;
  evidence: RetrievedEvidence[];
  nativeVerified: false;
}
const scopeFields = ['profile', 'app', 'app_version', 'profile_revision'] as const;
function checkText(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid preparation text.');
}
export function filterForScope(scope: EvidenceScope) {
  for (const field of scopeFields) if (field !== 'profile_revision' || scope[field] !== undefined) checkText(scope[field], 160);
  return { $and: scopeFields.filter(field => scope[field] !== undefined).map(field => ({ field, condition: { $eq: scope[field]! } })) };
}
export function validateCorpus(documents: EvidenceDocument[]): void {
  if (!Array.isArray(documents) || !documents.length || documents.length > 200) throw new Error('Preparation corpus must contain 1–200 records.');
  const ids = new Set<string>();
  for (const document of documents) {
    checkText(document.id, 200); checkText(document.text, 24000);
    if (ids.has(document.id)) throw new Error('Duplicate evidence ID.');
    ids.add(document.id);
    if (!document.metadata || Object.values(document.metadata).some(value => typeof value !== 'string')) throw new Error('Evidence metadata must contain strings.');
    filterForScope(document.metadata);
    checkText(document.metadata.kind, 100); checkText(document.metadata.provenance, 160);
  }
}
export function selectCorpus(documents: EvidenceDocument[], scope: EvidenceScope): EvidenceDocument[] {
  validateCorpus(documents); filterForScope(scope);
  return structuredClone(documents.filter(d => scopeFields.every(k => d.metadata[k] === scope[k])));
}
function snapshot(documents: EvidenceDocument[], request: RetrievalQuery, evidence: RetrievedEvidence[], retrieval: PreparedEvidence['retrieval']): PreparedEvidence {
  return {
    schemaVersion: 1, scope: { profile: request.profile, app: request.app, app_version: request.app_version, ...(request.profile_revision ? {profile_revision:request.profile_revision} : {}) },
    query: request.query, preparedAt: new Date().toISOString(), retrieval,
    corpusSha256: createHash('sha256').update(JSON.stringify(documents)).digest('hex'),
    evidence: structuredClone(evidence), nativeVerified: false,
  };
}
function boundedTopK(request: RetrievalQuery) {
  checkText(request.query, 2000);
  const topK = request.topK ?? 4;
  if (!Number.isInteger(topK) || topK < 1 || topK > 10) throw new Error('topK must be between 1 and 10.');
  return topK;
}
/** Explicit curated fallback. This does not claim semantic search or provider use. */
export function prepareCuratedContext(documents: EvidenceDocument[], request: RetrievalQuery): PreparedEvidence {
  const topK = boundedTopK(request);
  const selected = selectCorpus(documents, request);
  if (!selected.length) throw new Error('No evidence for the exact profile, app and version.');
  return snapshot(selected, request, selected.slice(0, topK).map(document => ({ document, score: 1 })), 'local-curated');
}
/** Call in a preparation worker. SDK auth/model loading is never a Translate dependency.
 * Session/client close are awaited; this does not promise a hard native-operation deadline.
 * Client factory is injected so host alone chooses/pins the real SDK dependency.
 */
export async function prepareMossContext(documents: EvidenceDocument[], request: RetrievalQuery, createClient: () => MossClientLike): Promise<PreparedEvidence> {
  const topK = boundedTopK(request);
  const selected = selectCorpus(documents, request);
  if (!selected.length) throw new Error('No evidence for the exact profile, app and version.');
  const trusted = new Map(selected.map(d => [d.id, d]));
  const client = createClient();
  let session: MossSessionLike | undefined;
  let result: PreparedEvidence | undefined;
  let failure: Error | undefined;
  try {
    session = await client.session(`lucienne-prep-${randomUUID()}`, 'moss-minilm');
    const counts = await session.addDocs(structuredClone(selected));
    if (counts.added !== selected.length || counts.updated !== 0) throw new Error('Moss ingestion readback mismatch.');
    const response = await session.query(request.query, { topK, filter: filterForScope(request) });
    if (!response || !Array.isArray(response.docs) || response.docs.length > topK) throw new Error('Malformed Moss result.');
    const seen = new Set<string>();
    const evidence = response.docs.map(hit => {
      const document = trusted.get(hit.id);
      if (!document || seen.has(hit.id) || !Number.isFinite(hit.score)) throw new Error('Moss returned unknown, duplicate or invalid evidence.');
      seen.add(hit.id);
      // Hydrate only canonical local text/metadata; search output cannot rewrite provenance.
      return { document, score: hit.score };
    });
    if (!evidence.length) throw new Error('Moss returned no applicable evidence.');
    result = snapshot(selected, request, evidence, 'moss');
  } catch {
    failure = new Error('Moss preparation failed; no context published.');
  } finally {
    try { await session?.close(); } catch { failure = new Error('Moss session close failed; inspect provider usage.'); }
    try { await client.close(); } catch { failure = new Error('Moss client close failed; inspect provider usage.'); }
  }
  if (failure) throw failure;
  return result!;
}
/** In-memory prepared cache: Translate reads synchronously; no providers are reachable. */
export class PreparedContextStore {
  #contexts = new Map<string, PreparedEvidence>();
  #key(scope: EvidenceScope) { filterForScope(scope); return JSON.stringify(scopeFields.map(k => scope[k])); }
  put(context: PreparedEvidence): void {
    if (context.schemaVersion !== 1 || context.nativeVerified !== false || !['moss', 'local-curated'].includes(context.retrieval) || !/^[0-9a-f]{64}$/.test(context.corpusSha256) || !Number.isFinite(Date.parse(context.preparedAt))) throw new Error('Invalid prepared context.');
    validateCorpus(context.evidence.map(e => e.document));
    if (context.evidence.some(e => !Number.isFinite(e.score) || !scopeFields.every(k => e.document.metadata[k] === context.scope[k]))) throw new Error('Context scope mismatch.');
    this.#contexts.set(this.#key(context.scope), structuredClone(context));
  }
  get(scope: EvidenceScope): PreparedEvidence | undefined { const result = this.#contexts.get(this.#key(scope)); return result ? structuredClone(result) : undefined; }
  clear(): void { this.#contexts.clear(); }
}
