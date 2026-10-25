import { checkTask } from './tasks.ts';
import type { Finding, TaskObservation, TaskState } from './tasks.ts';

export type KritaTaskAction = 'paint' | 'select' | 'transform';

/** Adapter normalization boundary, not a product contract. Krita adapter should construct this
 * from actual native readback. otherLayers is the COMPLETE layer-ID → SHA256 map
 * excluding taskState.layerId. An explicit {} means the document has no other
 * layers; an omitted map never means that. Widget/cursor geometry is ignored.
 * Digest semantics (pixel bytes, dimensions, etc.) must be identical across reads.
 */
export interface NativeKritaObservation {
  taskState: Pick<TaskState, 'pixelDigest' | 'selectionPixels' | 'selectionDigest' | 'bounds'> & { layerId: string };
  otherLayers: Readonly<Record<string, string>>;
}

export type KritaTaskState = TaskState & {
  layerId: string;
  otherLayerDigests: Readonly<Record<string, string>>;
};
export type KritaTaskObservation = TaskObservation & {
  action: KritaTaskAction;
  before: KritaTaskState;
  after: KritaTaskState;
};
type Normalization = { status: 'ready'; state: KritaTaskState }
  | { status: 'blocked'; findings: Finding[] };
export type KritaProjection = { status: 'ready'; observation: KritaTaskObservation; findings: Finding[] }
  | { status: 'fail' | 'blocked'; findings: Finding[] };
export interface KritaTaskValidation {
  status: 'pass' | 'fail' | 'blocked';
  findings: Finding[];
  observation?: KritaTaskObservation;
}

const record = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const pixels = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const bounds = (value: unknown): value is number[] => Array.isArray(value) && value.length === 4 && [...value].every(n => typeof n === 'number' && Number.isFinite(n));
const finding = (id: string, status: Finding['status'], detail: string): Finding => ({ id, status, detail });

/** Validates a producer's narrow projection and copies it, without borrowing
 * expected task output or reconstructing native state from cursor/UI changes. */
export function normalizeKritaObservation(value: unknown, phase: 'before' | 'after' = 'before'): Normalization {
  const blocked = (detail: string): Normalization => ({ status: 'blocked', findings: [finding(`krita.${phase}.readback`, 'blocked', detail)] });
  if (!record(value) || !record(value.taskState) || !Object.hasOwn(value, 'otherLayers') || !record(value.otherLayers)) {
    return blocked('Native taskState and an explicit complete otherLayers digest map are required');
  }
  const state = value.taskState;
  if (!Object.hasOwn(state, 'layerId') || !text(state.layerId)) return blocked('A native selected-layer ID is required');
  const others = Object.entries(value.otherLayers);
  if (others.some(([id, sha256]) => !text(id) || id === state.layerId || !digest(sha256))) {
    return blocked('Every other-layer entry needs a distinct native layer ID and a valid SHA256 digest');
  }
  if ((state.pixelDigest !== undefined && !digest(state.pixelDigest))
    || (state.selectionDigest !== undefined && !digest(state.selectionDigest))
    || (state.selectionPixels !== undefined && !pixels(state.selectionPixels))
    || (state.bounds !== undefined && !bounds(state.bounds))) {
    return blocked('Native pixel, selection or bounds readback is malformed');
  }
  const normalized: KritaTaskState = {
    layerId: state.layerId,
    otherLayerDigests: Object.freeze(Object.fromEntries(others.map(([id, sha256]) => [id, (sha256 as string).toLowerCase()]))),
  };
  if (digest(state.pixelDigest)) normalized.pixelDigest = state.pixelDigest.toLowerCase();
  if (digest(state.selectionDigest)) normalized.selectionDigest = state.selectionDigest.toLowerCase();
  if (pixels(state.selectionPixels)) normalized.selectionPixels = state.selectionPixels;
  if (bounds(state.bounds)) normalized.bounds = Object.freeze([...state.bounds]);
  return { status: 'ready', state: Object.freeze(normalized) };
}

/** `ready` means projection and layer-preservation checks succeeded, not that the
 * requested task succeeded. Call validateKritaTask for the action verdict. */
export function projectKritaTask(action: KritaTaskAction, beforeRaw: unknown, afterRaw: unknown, evidenceRefs: unknown): KritaProjection {
  if (!['paint', 'select', 'transform'].includes(action)) {
    return { status: 'blocked', findings: [finding('krita.action', 'blocked', 'Only paint, select and transform are supported')] };
  }
  if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0 || ![...evidenceRefs].every(text) || new Set(evidenceRefs).size !== evidenceRefs.length) {
    return { status: 'blocked', findings: [finding(`krita.${action}.evidence`, 'blocked', 'Distinct nonempty native evidence references are required')] };
  }
  const before = normalizeKritaObservation(beforeRaw, 'before');
  const after = normalizeKritaObservation(afterRaw, 'after');
  if (before.status !== 'ready' || after.status !== 'ready') {
    return { status: 'blocked', findings: [
      ...(before.status === 'blocked' ? before.findings : []),
      ...(after.status === 'blocked' ? after.findings : []),
    ] };
  }
  const beforeIds = Object.keys(before.state.otherLayerDigests);
  const afterIds = Object.keys(after.state.otherLayerDigests);
  const sameOthers = beforeIds.length === afterIds.length && beforeIds.every(id =>
    Object.hasOwn(after.state.otherLayerDigests, id) && before.state.otherLayerDigests[id] === after.state.otherLayerDigests[id]);
  const findings = [
    finding(`krita.${action}.same-layer`, before.state.layerId === after.state.layerId ? 'pass' : 'fail', 'Before and after refer to the same native selected layer'),
    finding(`krita.${action}.other-layers`, sameOthers ? 'pass' : 'fail', 'The complete observed set of other layers and its digests remain unchanged'),
  ];
  if (findings.some(item => item.status === 'fail')) return { status: 'fail', findings };
  return { status: 'ready', findings, observation: {
    action, before: before.state, after: after.state, evidenceRefs: [...evidenceRefs],
  } };
}

/** Layer preservation alone cannot pass a task. Existing native action assertions
 * must also pass; absent action-specific observations remain blocked. */
export function validateKritaTask(action: KritaTaskAction, beforeRaw: unknown, afterRaw: unknown, evidenceRefs: unknown): KritaTaskValidation {
  const projection = projectKritaTask(action, beforeRaw, afterRaw, evidenceRefs);
  if (projection.status !== 'ready') return projection;
  const actionFinding = checkTask('krita', projection.observation);
  return { status: actionFinding.status, findings: [...projection.findings, actionFinding], observation: projection.observation };
}
