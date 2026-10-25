import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Capability, Operation, PlannerRequest } from '../contracts/index.js';
import type { NativeReadback } from '../contracts/ports.js';
import type { RunRecorder } from './capture.ts';
import type { BlenderTaskState, NativeTaskSnapshot } from './native-checks.ts';

type Selection = Pick<PlannerRequest, 'source' | 'target' | 'scenarioId' | 'bindingApplicability' | 'evidenceRefs'>;
type Capture = ReturnType<RunRecorder['snapshot']>;
const recipeRef = 'blender:binding-recipes:5.2.3-v1';
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,160}$/.test(value);
const refs = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
  && value.length <= 32 && value.every(id) && new Set(value).size === value.length;
function fail(code: string): never { throw new Error(`BLENDER_EVIDENCE_${code}`); }
const inside = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return !!path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
function copy<T>(value: T): T {
  try { return structuredClone(value); } catch { return fail('INPUT_INVALID'); }
}
function captureFor(recorder: RunRecorder): Capture {
  const capture = recorder.snapshot();
  if (capture.runId !== recorder.runId || !id(capture.runId) || !id(capture.buildId)
    || !['native', 'fixture'].includes(capture.evidenceKind) || capture.target?.appId !== 'blender'
    || !Array.isArray(capture.artifacts)) fail('CAPTURE_IDENTITY');
  return capture;
}

/** Read only already-adopted files. Hash the exact bytes that are parsed, rather
 * than relying on adoption's earlier check or a separately read verification. */
async function envelopeFor(recorder: RunRecorder, capture: Capture, ref: string, kind: string): Promise<Record<string, unknown>> {
  const matches = capture.artifacts.filter(artifact => artifact.id === ref);
  if (matches.length !== 1) fail(matches.length ? 'REF_AMBIGUOUS' : 'REF_MISSING');
  const artifact = matches[0];
  if (artifact.id !== ref || artifact.buildId !== capture.buildId || artifact.runId !== capture.runId
    || artifact.evidenceKind !== capture.evidenceKind || typeof artifact.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) fail('MANIFEST_IDENTITY');
  if (typeof artifact.path !== 'string' || !artifact.path || isAbsolute(artifact.path)) fail('ROOT_ESCAPE');
  let root: string, file: string;
  try {
    root = await realpath(recorder.directory);
    const candidate = resolve(root, artifact.path);
    if (!inside(root, candidate)) fail('ROOT_ESCAPE');
    file = await realpath(candidate);
  } catch (error) {
    if (error instanceof Error && error.message === 'BLENDER_EVIDENCE_ROOT_ESCAPE') throw error;
    return fail('FILE_UNREADABLE');
  }
  if (!inside(root, file)) fail('ROOT_ESCAPE');
  let bytes: Buffer;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024) fail('FILE_INVALID');
      bytes = await handle.readFile();
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof Error && error.message === 'BLENDER_EVIDENCE_FILE_INVALID') throw error;
    return fail('FILE_UNREADABLE');
  }
  if (bytes.length > 16 * 1024 * 1024) fail('FILE_INVALID');
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256.toLowerCase()) fail('HASH_MISMATCH');
  let envelope: unknown;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { return fail('JSON_INVALID'); }
  if (!record(envelope) || envelope.version !== 1 || envelope.id !== ref || envelope.buildId !== capture.buildId
    || envelope.runId !== capture.runId || envelope.evidenceKind !== capture.evidenceKind || envelope.kind !== kind) fail('ENVELOPE_IDENTITY');
  return envelope;
}

/** Blender adapter authored policy envelope. The runner supplies trusted full source,
 * target, scenario and catalog; task artifacts do not independently attest them.
 * This verifies the run-bound declaration, never readiness or native execution.
 * Fixture captures remain fixture evidence; this function never upgrades them. */
export async function verifyBlenderBindingEvidence(recorder: RunRecorder, selection: Selection, catalog: readonly Capability[]): Promise<void> {
  const chosen = copy(selection), expectedCatalog = copy(catalog), capture = captureFor(recorder);
  if (!chosen || !chosen.source || !refs(chosen.evidenceRefs) || !chosen.bindingApplicability
    || !Array.isArray(expectedCatalog) || expectedCatalog.length === 0) fail('INPUT_INVALID');
  if (!isDeepStrictEqual(capture.source, chosen.source) || !isDeepStrictEqual(capture.target, chosen.target)
    || capture.scenarioId !== chosen.scenarioId) fail('SELECTION_MISMATCH');
  const policy = chosen.bindingApplicability;
  if (policy.version !== 1 || policy.scenarioId !== chosen.scenarioId || !isDeepStrictEqual(policy.target, chosen.target)
    || !isDeepStrictEqual(policy.source, { profileId: chosen.source.profileId, revision: chosen.source.revision, sourceApp: chosen.source.sourceApp })
    || !Array.isArray(policy.entries)) fail('POLICY_MISMATCH');
  const required = new Set([recipeRef]);
  for (const entry of policy.entries) {
    if (!entry || !refs(entry.evidenceRefs)) fail('INPUT_INVALID');
    for (const ref of entry.evidenceRefs) required.add(ref);
  }
  for (const ref of required) {
    if (!chosen.evidenceRefs.includes(ref)) fail('REF_MISSING');
    const envelope = await envelopeFor(recorder, capture, ref, 'binding-recipe-declaration');
    if (envelope.provenance !== 'adapter-authored-policy' || !isDeepStrictEqual(envelope.target, chosen.target)
      || !isDeepStrictEqual(envelope.bindingApplicability, policy) || !isDeepStrictEqual(envelope.catalog, expectedCatalog)) fail('POLICY_MISMATCH');
  }
}

function withoutRefs(value: Record<string, unknown>): Record<string, unknown> {
  const { evidenceRefs: _, ...observed } = value;
  return observed;
}
function projection(project: (value: unknown) => NativeTaskSnapshot<BlenderTaskState>, value: unknown): NativeTaskSnapshot<BlenderTaskState> {
  try {
    const result = copy(project(copy(value)));
    if (!record(result) || typeof result.contextId !== 'string' || !result.contextId.trim() || !record(result.taskState)
      || !refs(result.evidenceRefs)) fail('PROJECTION_INVALID');
    return result;
  } catch { return fail('PROJECTION_INVALID'); }
}

/** Verify every returned ref and every raw observation field, including geometry.
 * Blender adapter serializes empty observation refs before assigning the saved artifact ID.
 * Restore that ID only on the copy passed to the owner's validating projector.
 * A trusted runner still binds this observed run to its source/target/scenario. */
export async function verifyBlenderObservationEvidence(recorder: RunRecorder,
  identity: { runId: string; requestId: string; generation: number }, raw: { evidenceRefs: string[] },
  project: (value: unknown) => NativeTaskSnapshot<BlenderTaskState>): Promise<void> {
  const expectedIdentity = copy(identity), observed = copy(raw), capture = captureFor(recorder);
  if (!expectedIdentity || expectedIdentity.runId !== capture.runId || !id(expectedIdentity.requestId)
    || !Number.isSafeInteger(expectedIdentity.generation) || expectedIdentity.generation < 0) fail('OBSERVATION_IDENTITY');
  if (!record(observed) || !refs(observed.evidenceRefs) || typeof project !== 'function') fail('INPUT_INVALID');
  const expectedProjection = projection(project, observed);
  if (!isDeepStrictEqual(expectedProjection.evidenceRefs, observed.evidenceRefs)) fail('PROJECTION_MISMATCH');
  for (const ref of observed.evidenceRefs) {
    const envelope = await envelopeFor(recorder, capture, ref, 'native-task-observation');
    if (envelope.requestId !== expectedIdentity.requestId || envelope.generation !== expectedIdentity.generation
      || typeof envelope.observedAt !== 'string' || !Number.isFinite(Date.parse(envelope.observedAt))) fail('OBSERVATION_IDENTITY');
    const saved = envelope.observation;
    if (!record(saved) || !isDeepStrictEqual(saved.evidenceRefs, [])
      || !isDeepStrictEqual(withoutRefs(saved), withoutRefs(observed))) fail('OBSERVATION_MISMATCH');
    const savedProjection = projection(project, { ...saved, evidenceRefs: [ref] });
    if (!isDeepStrictEqual(savedProjection.evidenceRefs, [ref]) || savedProjection.contextId !== expectedProjection.contextId
      || !isDeepStrictEqual(savedProjection.taskState, expectedProjection.taskState)) fail('PROJECTION_MISMATCH');
  }
}

function operationSet(value: unknown): Operation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64
    || ![...value].every(operation => record(operation) && id(operation.capabilityId)
      && typeof operation.value === 'string' && operation.value.length > 0 && operation.value.length <= 160
      && Object.keys(operation).length === 2)
    || new Set(value.map(operation => operation.capabilityId)).size !== value.length) fail('READBACK_OPERATIONS_INVALID');
  return [...value].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}
function withoutReadbackOperations(value: Record<string, unknown>): Record<string, unknown> {
  const { operations: _, evidenceRefs: __, ...observed } = value;
  return observed;
}

/** Blender adapter stores the full native wire readback with empty refs before projecting the
 * managed catalog. The trusted owner projector validates that full wire state.
 * This binds the returned receipt to those bytes; it does not assert readiness
 * independently or add absent target/profile fields to the native envelope. */
export async function verifyBlenderReadbackEvidence(recorder: RunRecorder,
  identity: { runId: string; requestId: string; generation: number }, readback: NativeReadback,
  project: (operations: readonly Operation[], catalog: readonly Capability[]) => Operation[],
  catalog: readonly Capability[]): Promise<void> {
  const expectedIdentity = copy(identity), returned = copy(readback), managedCatalog = copy(catalog), capture = captureFor(recorder);
  if (!expectedIdentity || expectedIdentity.runId !== capture.runId || !id(expectedIdentity.requestId)
    || !Number.isSafeInteger(expectedIdentity.generation) || expectedIdentity.generation < 0) fail('READBACK_IDENTITY');
  if (!record(returned) || returned.requestId !== expectedIdentity.requestId || typeof returned.targetVisible !== 'boolean'
    || typeof returned.interactive !== 'boolean' || !refs(returned.evidenceRefs) || typeof project !== 'function'
    || !Array.isArray(managedCatalog) || managedCatalog.length === 0 || managedCatalog.length > 64
    || ![...managedCatalog].every(capability => record(capability) && id(capability.id) && Array.isArray(capability.values))
    || new Set(managedCatalog.map(capability => capability.id)).size !== managedCatalog.length) fail('READBACK_INPUT_INVALID');
  const expectedOperations = operationSet(returned.operations);
  if (expectedOperations.length !== managedCatalog.length || expectedOperations.some(operation =>
    !managedCatalog.some(capability => capability.id === operation.capabilityId && capability.values.includes(operation.value)))) fail('READBACK_OPERATIONS_INVALID');
  for (const ref of returned.evidenceRefs) {
    const envelope = await envelopeFor(recorder, capture, ref, 'native-readback');
    if (envelope.requestId !== expectedIdentity.requestId || envelope.generation !== expectedIdentity.generation
      || typeof envelope.observedAt !== 'string' || !Number.isFinite(Date.parse(envelope.observedAt))) fail('READBACK_IDENTITY');
    const saved = envelope.observation;
    if (!record(saved) || !isDeepStrictEqual(saved.evidenceRefs, [])
      || !isDeepStrictEqual(withoutReadbackOperations(saved), withoutReadbackOperations(returned))) fail('READBACK_MISMATCH');
    operationSet(saved.operations); // Validate without dropping/reordering the full owner input.
    let projected: Operation[];
    try { projected = project(copy(saved.operations as Operation[]), copy(managedCatalog)); }
    catch { return fail('READBACK_PROJECTION_INVALID'); }
    if (!isDeepStrictEqual(operationSet(projected), expectedOperations)) fail('READBACK_MISMATCH');
  }
}
