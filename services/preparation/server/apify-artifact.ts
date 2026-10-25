import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, parse, resolve, sep } from 'node:path';
import { assertRoute, TargetSchema } from '../../../contracts/index.js';
import type { SourceProfile, Target } from '../../../contracts/index.js';
import type { ImportedOfficialDocument } from '../providers/apify.js';
import type { EvidenceDocument, RetrievalQuery } from '../retrieval.js';
import { validateServiceSource } from './recipes.js';

// Deployment-specific document approvals are deliberately absent.
const reviewed: { corpusReadback: ImportedOfficialDocument[] } = { corpusReadback: [] };

const MAX_FILE_BYTES = 1024 * 1024;
const KEYS = ['id', 'url', 'appId', 'documentationVersion', 'targetAppVersion', 'expectedTopic', 'provider',
  'provenance', 'nativeCompatibility', 'markdown', 'sha256', 'retrievedAt', 'runId', 'actorId', 'buildId'] as const;
const REVIEWED_KEYS = KEYS.filter(key => key !== 'markdown' && key !== 'sha256');
class ArtifactError extends Error {}
function fail(code: string): never { throw new ArtifactError(code); }
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function validateDocuments(value: unknown): ImportedOfficialDocument[] {
  if (!reviewed.corpusReadback.length) return fail('APIFY_ARTIFACT_REVIEW_REQUIRED');
  if (!Array.isArray(value) || value.length !== reviewed.corpusReadback.length) return fail('APIFY_ARTIFACT_DOCUMENT_COUNT');
  const seen = new Set<string>();
  return value.map(item => {
    if (!record(item) || Object.keys(item).length !== KEYS.length
        || KEYS.some(key => !Object.hasOwn(item, key) || typeof item[key] !== 'string')) return fail('APIFY_ARTIFACT_SHAPE');
    const known = reviewed.corpusReadback.find(document => document.id === item.id);
    if (!known || seen.has(item.id as string)
        || REVIEWED_KEYS.some(key => item[key] !== known[key as keyof typeof known])) return fail('APIFY_ARTIFACT_REVIEW_MISMATCH');
    seen.add(item.id as string);
    if (item.sha256 !== known.sha256) return fail('APIFY_ARTIFACT_REVIEWED_CONTENT_MISMATCH');
    const markdown = item.markdown as string;
    if (item.provider !== 'apify' || item.provenance !== 'official-documentation' || item.nativeCompatibility !== 'unverified'
        || !/^[a-f0-9]{64}$/.test(item.sha256 as string) || hash(markdown) !== item.sha256
        || markdown.trim().length < 40 || Buffer.byteLength(markdown) > 256 * 1024 || markdown.includes('\0')
        || !markdown.toLowerCase().includes(known.expectedTopic.toLowerCase())) return fail('APIFY_ARTIFACT_CONTENT_INVALID');
    return Object.fromEntries(KEYS.map(key => [key, item[key]])) as unknown as ImportedOfficialDocument;
  });
}

/** Host-configured local artifact only. File bytes are pinned independently from each document's content hash. */
export function loadApifyArtifact(path: string, expectedFileSha256: string): ImportedOfficialDocument[] {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !isAbsolute(path)
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('//') || resolve(path) !== path) return fail('APIFY_ARTIFACT_LOCAL_PATH_REQUIRED');
  if (typeof expectedFileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFileSha256)) return fail('APIFY_ARTIFACT_HASH_REQUIRED');
  let fd: number | undefined;
  try {
    let part = parse(path).root;
    for (const segment of path.slice(part.length).split(sep)) {
      part = resolve(part, segment);
      if (lstatSync(part).isSymbolicLink()) return fail('APIFY_ARTIFACT_SYMLINK');
    }
    const prior = lstatSync(path);
    if (!prior.isFile()) return fail('APIFY_ARTIFACT_UNSAFE_FILE');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || process.getuid === undefined || stat.uid !== process.getuid()
        || (stat.mode & 0o7777 & ~0o600) !== 0 || stat.nlink !== 1 || stat.dev !== prior.dev || stat.ino !== prior.ino
        || stat.size < 1 || stat.size > MAX_FILE_BYTES) return fail('APIFY_ARTIFACT_UNSAFE_FILE');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    const after = fstatSync(fd);
    if (bytes > MAX_FILE_BYTES || bytes !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return fail('APIFY_ARTIFACT_CHANGED');
    const content = buffer.subarray(0, bytes);
    if (hash(content) !== expectedFileSha256) return fail('APIFY_ARTIFACT_FILE_HASH_MISMATCH');
    return validateDocuments(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)));
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    return fail('APIFY_ARTIFACT_READ_FAILED');
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Bind reviewed excerpts to one validated profile revision and an eligible source/target app. */
export function apifyContextRecipe(documents: ImportedOfficialDocument[], source: SourceProfile, target: Target): {
  documents: EvidenceDocument[]; query: RetrievalQuery;
} {
  const corpus = validateDocuments(documents);
  let profile: SourceProfile, destination: Target;
  try {
    profile = validateServiceSource(source);
    destination = TargetSchema.parse(target);
    assertRoute(profile.sourceApp, destination.appId);
  } catch { return fail('APIFY_CONTEXT_INVALID_PROFILE_OR_ROUTE'); }
  const eligible = corpus.filter(document => document.appId === destination.appId || document.appId === profile.sourceApp);
  if (!eligible.length) return fail('APIFY_CONTEXT_ROUTE_UNAVAILABLE');
  const selected = eligible.find(document => document.appId === destination.appId) ?? eligible[0];
  const sameScope = eligible.filter(document => document.appId === selected.appId
    && document.documentationVersion === selected.documentationVersion).sort((a, b) => a.id.localeCompare(b.id));
  const evidence: EvidenceDocument[] = [];
  for (const document of sameScope) {
    const header = `Official documentation excerpt.\nSource: ${document.url}\nDocumentation: ${document.documentationVersion}; recorded target app: ${document.targetAppVersion}.\nOriginal SHA-256: ${document.sha256}\nNative verified: false.\n\n`;
    const budget = 700 - header.length;
    if (budget < 100) return fail('APIFY_CONTEXT_EXCERPT_BUDGET');
    let offset = 0, index = 0;
    while (offset < document.markdown.length) {
      let end = Math.min(offset + budget, document.markdown.length);
      if (end < document.markdown.length && /[\uD800-\uDBFF]/.test(document.markdown[end - 1])) end--;
      const excerpt = document.markdown.slice(offset, end);
      offset = end; index++;
      evidence.push({ id: `apify:${document.id}:excerpt:${index}`, text: header + excerpt,
        metadata: { profile: profile.profileId, profile_revision: profile.revision, app: document.appId,
          app_version: document.documentationVersion, documentation_version: document.documentationVersion,
          target_app_version: document.targetAppVersion, kind: 'official-document-excerpt', provenance: 'official-documentation',
          provider: 'apify', source_url: document.url, original_sha256: document.sha256, excerpt_sha256: hash(excerpt),
          excerpt: 'true', excerpt_index: String(index), native_verified: 'false', native_compatibility: 'unverified',
          retrieved_at: document.retrievedAt, actor_id: document.actorId, build_id: document.buildId, run_id: document.runId } });
      if (evidence.length > 200) return fail('APIFY_CONTEXT_TOO_LARGE');
    }
  }
  return { documents: evidence, query: { profile: profile.profileId, profile_revision: profile.revision,
    app: selected.appId, app_version: selected.documentationVersion,
    query: `Official ${selected.appId} ${selected.expectedTopic} documentation and documented controls.`, topK: 1 } };
}
