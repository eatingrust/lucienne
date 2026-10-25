import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Capability, PlannerRequest } from '../contracts/index.js';
import type { NativeReadback } from '../contracts/ports.js';
import type { RunRecorder } from './capture.ts';
import type { NativeTaskSnapshot, PlaybackTaskState } from './native-checks.ts';

type Selection = Pick<PlannerRequest, 'source' | 'target' | 'scenarioId' | 'bindingApplicability' | 'evidenceRefs'>;
type Identity = { runId: string; requestId: string; generation: number };
type Capture = ReturnType<RunRecorder['snapshot']>;
const recipeRef = 'reaper:binding-recipes:7.83-v1';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 32
  && [...value].every(id) && new Set(value).size === value.length;
function fail(code: string): never { throw new Error(`REAPER_EVIDENCE_${code}`); }
function copy<T>(value: T): T {
  try { return structuredClone(value); } catch { return fail('INPUT_INVALID'); }
}
function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
function captureFor(recorder: RunRecorder): Capture {
  const capture = recorder.snapshot();
  if (capture.runId !== recorder.runId || !id(capture.runId) || !id(capture.buildId)
    || !['native', 'fixture'].includes(capture.evidenceKind) || capture.target?.appId !== 'reaper'
    || !Array.isArray(capture.artifacts)) fail('CAPTURE_IDENTITY');
  return capture;
}

/** Only adopted files under this recorder are inspected. External policy proof
 * gets this same byte/manifest check without assigning it recipe semantics. */
async function bytesFor(recorder: RunRecorder, capture: Capture, ref: string): Promise<Buffer> {
  const matches = capture.artifacts.filter(artifact => artifact.id === ref);
  if (matches.length !== 1) fail(matches.length ? 'REF_AMBIGUOUS' : 'REF_MISSING');
  const artifact = matches[0];
  if (artifact.runId !== capture.runId || artifact.buildId !== capture.buildId || artifact.evidenceKind !== capture.evidenceKind
    || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) fail('MANIFEST_IDENTITY');
  if (typeof artifact.path !== 'string' || !artifact.path || isAbsolute(artifact.path)) fail('ROOT_ESCAPE');
  let root: string, file: string;
  try {
    root = await realpath(recorder.directory);
    const candidate = resolve(root, artifact.path);
    if (!inside(root, candidate)) fail('ROOT_ESCAPE');
    file = await realpath(candidate);
  } catch (error) {
    if (error instanceof Error && error.message === 'REAPER_EVIDENCE_ROOT_ESCAPE') throw error;
    return fail('FILE_UNREADABLE');
  }
  if (!inside(root, file)) fail('ROOT_ESCAPE');
  let bytes: Buffer;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024) fail('FILE_INVALID');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message === 'REAPER_EVIDENCE_FILE_INVALID') throw error;
    return fail('FILE_UNREADABLE');
  }
  if (bytes.length > 16 * 1024 * 1024) fail('FILE_INVALID');
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256.toLowerCase()) fail('HASH_MISMATCH');
  return bytes;
}
async function envelopeFor(recorder: RunRecorder, capture: Capture, ref: string): Promise<Record<string, unknown>> {
  const bytes = await bytesFor(recorder, capture, ref);
  let envelope: unknown;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { return fail('JSON_INVALID'); }
  if (!record(envelope) || envelope.version !== 1 || envelope.id !== ref || envelope.buildId !== capture.buildId
    || envelope.runId !== capture.runId || envelope.evidenceKind !== capture.evidenceKind) fail('ENVELOPE_IDENTITY');
  return envelope;
}
function assertIdentity(identity: Identity, capture: Capture): void {
  if (!identity || identity.runId !== capture.runId || !id(identity.requestId)
    || !Number.isSafeInteger(identity.generation) || identity.generation < 0) fail('REQUEST_IDENTITY');
}
async function observedFor(recorder: RunRecorder, capture: Capture, ref: string, identity: Identity,
  prefix: 'reaper:task:' | 'reaper:readback:'): Promise<Record<string, unknown>> {
  if (!ref.startsWith(prefix) || ref.length === prefix.length) fail('REF_KIND');
  const envelope = await envelopeFor(recorder, capture, ref);
  // REAPER adapter record() has no kind field: the task/readback distinction is in its ID.
  if (Object.hasOwn(envelope, 'kind')) fail('ENVELOPE_IDENTITY');
  if (envelope.requestId !== identity.requestId || envelope.generation !== identity.generation
    || typeof envelope.observedAt !== 'string' || !Number.isFinite(Date.parse(envelope.observedAt))) fail('REQUEST_IDENTITY');
  if (!record(envelope.observed) || !isDeepStrictEqual(envelope.observed.evidenceRefs, [])) fail('OBSERVED_INVALID');
  return envelope.observed;
}
function withoutRefs(value: Record<string, unknown>): Record<string, unknown> {
  const { evidenceRefs: _, ...observed } = value;
  return observed;
}

/** REAPER adapter declaration contract. Full selection/catalog/semantics are trusted
 * runner inputs. The first committed translate request corroborates the initial
 * preparation refs; later chat refs are not required to equal that initial set.
 * External policy refs remain separate adopted proof. Hashes prove integrity,
 * not native execution, source authenticity or semantic truth. Fixture kind is
 * retained; this verifier never upgrades synthetic evidence to native. */
export async function verifyReaperBindingEvidence(recorder: RunRecorder, selection: Selection, catalog: readonly Capability[],
  nativeSemantics: Readonly<Record<string, string>>): Promise<void> {
  const chosen = copy(selection), expectedCatalog = copy(catalog), semantics = copy(nativeSemantics), capture = captureFor(recorder);
  if (!chosen || !chosen.source || !refs(chosen.evidenceRefs) || !chosen.bindingApplicability
    || !Array.isArray(expectedCatalog) || expectedCatalog.length === 0 || !record(semantics)) fail('INPUT_INVALID');
  if (!isDeepStrictEqual(capture.source, chosen.source) || !isDeepStrictEqual(capture.target, chosen.target)
    || capture.scenarioId !== chosen.scenarioId) fail('SELECTION_MISMATCH');
  const policy = chosen.bindingApplicability;
  if (policy.version !== 1 || policy.scenarioId !== chosen.scenarioId || !isDeepStrictEqual(policy.target, chosen.target)
    || !isDeepStrictEqual(policy.source, { profileId: chosen.source.profileId, revision: chosen.source.revision, sourceApp: chosen.source.sourceApp })
    || !Array.isArray(policy.entries)) fail('POLICY_MISMATCH');
  const required = new Set<string>([recipeRef]);
  for (const entry of policy.entries) {
    if (!entry || !refs(entry.evidenceRefs)) fail('INPUT_INVALID');
    for (const ref of entry.evidenceRefs) required.add(ref);
  }
  if ([...required].some(ref => !chosen.evidenceRefs.includes(ref))) fail('REF_MISSING');
  const canonical = expectedCatalog.filter(capability => capability.bindingAction).map(capability => {
    const action = capability.bindingAction!;
    if (!Object.hasOwn(semantics, action) || typeof semantics[action] !== 'string' || !semantics[action].trim()) fail('SEMANTICS_INVALID');
    return { capabilityId: capability.id, bindingAction: action, limitation: semantics[action] };
  });
  const external = [...required].filter(ref => ref !== recipeRef);
  const initial = capture.commits[0]?.request;
  if (!initial || initial.kind !== 'translate' || initial.runId !== capture.runId || !refs(initial.evidenceRefs)) fail('INITIAL_REQUEST_MISSING');
  if (!isDeepStrictEqual(initial.source, chosen.source) || !isDeepStrictEqual(initial.target, chosen.target)
    || initial.scenarioId !== chosen.scenarioId || !isDeepStrictEqual(initial.catalog, expectedCatalog)
    || !isDeepStrictEqual(initial.bindingApplicability, policy) || chosen.evidenceRefs.some(ref => !initial.evidenceRefs.includes(ref))) fail('INITIAL_REQUEST_MISMATCH');
  const envelope = await envelopeFor(recorder, capture, recipeRef);
  if (envelope.kind !== 'binding-recipe-declaration' || envelope.provenance !== 'adapter-validated-host-policy'
    || !isDeepStrictEqual(envelope.target, chosen.target) || envelope.scenarioId !== chosen.scenarioId
    || !isDeepStrictEqual(envelope.source, chosen.source) || !isDeepStrictEqual(envelope.bindingApplicability, policy)
    || !isDeepStrictEqual(envelope.catalog, expectedCatalog) || !isDeepStrictEqual(envelope.canonicalMappedSemantics, canonical)
    || !isDeepStrictEqual(envelope.externalEvidenceRefs, external)) fail('POLICY_MISMATCH');
  if (!isDeepStrictEqual(envelope.initialRequestEvidenceRefs, initial.evidenceRefs)) fail('INITIAL_REFS_MISMATCH');
  for (const ref of external) await bytesFor(recorder, capture, ref);
}

function projection(project: (value: unknown) => NativeTaskSnapshot<PlaybackTaskState>, value: unknown): NativeTaskSnapshot<PlaybackTaskState> {
  try {
    const result = copy(project(copy(value)));
    if (!record(result) || typeof result.contextId !== 'string' || !result.contextId.trim() || !record(result.taskState)
      || !refs(result.evidenceRefs)) fail('PROJECTION_INVALID');
    return result;
  } catch { return fail('PROJECTION_INVALID'); }
}

/** The actual owner projector validates project/process/media/clip identities.
 * Compare every raw field first, then restore only the verified artifact ID on
 * the projection copy. Full projected context and timeline state must agree. */
export async function verifyReaperObservationEvidence(recorder: RunRecorder, identity: Identity, raw: { evidenceRefs: string[] },
  project: (value: unknown) => NativeTaskSnapshot<PlaybackTaskState>): Promise<void> {
  const expectedIdentity = copy(identity), returned = copy(raw), capture = captureFor(recorder);
  assertIdentity(expectedIdentity, capture);
  if (!record(returned) || !refs(returned.evidenceRefs) || typeof project !== 'function') fail('INPUT_INVALID');
  const expected = projection(project, returned);
  if (!isDeepStrictEqual(expected.evidenceRefs, returned.evidenceRefs)) fail('PROJECTION_MISMATCH');
  for (const ref of returned.evidenceRefs) {
    const saved = await observedFor(recorder, capture, ref, expectedIdentity, 'reaper:task:');
    if (!isDeepStrictEqual(withoutRefs(saved), withoutRefs(returned))) fail('OBSERVATION_MISMATCH');
    const projected = projection(project, { ...saved, evidenceRefs: [ref] });
    if (!isDeepStrictEqual(projected.evidenceRefs, [ref]) || projected.contextId !== expected.contextId
      || !isDeepStrictEqual(projected.taskState, expected.taskState)) fail('PROJECTION_MISMATCH');
  }
}

/** REAPER persists the same complete shared NativeReadback it returns, before
 * replacing empty runtime refs. There is no Blender-style operation projection. */
export async function verifyReaperReadbackEvidence(recorder: RunRecorder, identity: Identity, readback: NativeReadback): Promise<void> {
  const expectedIdentity = copy(identity), returned = copy(readback), capture = captureFor(recorder);
  assertIdentity(expectedIdentity, capture);
  if (!record(returned) || returned.requestId !== expectedIdentity.requestId || typeof returned.targetVisible !== 'boolean'
    || typeof returned.interactive !== 'boolean' || !refs(returned.evidenceRefs) || !Array.isArray(returned.operations)
    || returned.operations.length === 0 || returned.operations.length > 64
    || ![...returned.operations].every(operation => record(operation) && id(operation.capabilityId)
      && typeof operation.value === 'string' && operation.value.length > 0 && operation.value.length <= 160 && Object.keys(operation).length === 2)
    || new Set(returned.operations.map(operation => operation.capabilityId)).size !== returned.operations.length) fail('READBACK_INVALID');
  for (const ref of returned.evidenceRefs) {
    const saved = await observedFor(recorder, capture, ref, expectedIdentity, 'reaper:readback:');
    if (!isDeepStrictEqual(withoutRefs(saved), withoutRefs(returned))) fail('READBACK_MISMATCH');
  }
}
