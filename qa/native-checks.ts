import { checkTask } from './tasks.ts';
import type { Clip, Finding, TaskObservation, TaskState } from './tasks.ts';

/** Native observer projections only; these do not extend NativeAdapter/NativeReadback.
 * contextId must identify the same actual scene/project, not a requested patch
 * or an ID invented from the run. Producers map their native identity to this key.
 * Positions and clips are complete observed sets: never prefilter to the edited item.
 * Every snapshot carries existing native evidence refs; shape checks are not proof
 * of native execution. RunRecorder and artifact verification retain that authority.
 */
export interface NativeTaskSnapshot<State> {
  contextId: string;
  taskState: State;
  evidenceRefs: readonly string[];
}
export interface BlenderTaskState {
  selectedIds: string[];
  positions: Record<string, readonly [number, number, number]>;
}
export type NativeTimelineClip = Clip & { trackId: string };
export interface TimelineTaskState {
  clips: NativeTimelineClip[];
  playheadSeconds?: number;
  transport?: 'playing' | 'stopped';
  imageClipCount?: number;
  titleClipCount?: number;
}
export interface PlaybackTaskState extends TimelineTaskState {
  playheadSeconds: number;
  transport: 'playing' | 'stopped';
}
type Pair<State> = { before: NativeTaskSnapshot<State>; after: NativeTaskSnapshot<State> };
export type NativeCheckInput =
  | ({ target: 'blender'; action: 'select' | 'move' } & Pair<BlenderTaskState>)
  | ({ target: 'reaper'; action: 'split' | 'trim' } & Pair<TimelineTaskState>)
  | ({ target: 'kdenlive'; action: 'cut' | 'trim' | 'montage-title' } & Pair<TimelineTaskState>)
  | ({ target: 'reaper' | 'kdenlive'; action: 'play' } & Pair<PlaybackTaskState>);
export type NativeCheckedObservation = TaskObservation & {
  before: TaskState & { contextId: string };
  after: TaskState & { contextId: string };
};
export interface NativeCheckResult {
  status: 'pass' | 'fail' | 'blocked';
  findings: Finding[];
  /** Omitted for malformed input or failed context/preservation guards, so a caller
   * cannot record a weaker TaskObservation that would lose these failures. */
  observation?: NativeCheckedObservation;
}
export interface NativeTaskRecorder {
  writeObservation(id: string, observation: unknown): Promise<string>;
  recordTask(observation: TaskObservation): void;
}
export interface NativeRecordedCheck extends NativeCheckResult {
  recorded: boolean;
  artifactRefs: string[];
}

type Target = NativeCheckInput['target'];
type Snapshot = NativeTaskSnapshot<TaskState>;
type Prepared = { target: Target; action: string; before: Snapshot; after: Snapshot; observation: NativeCheckedObservation };
type Preparation = { prepared: Prepared } | { blocked: Finding };
const actions = { blender: ['select', 'move'], reaper: ['split', 'trim', 'play'], kdenlive: ['cut', 'trim', 'play', 'montage-title'] };
const plain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && [...value].every(text) && new Set(value).size === value.length;
const vector = (value: unknown): value is [number, number, number] => Array.isArray(value) && value.length === 3 && [...value].every(finite);
const fail = (id: string, status: Finding['status'], detail: string): Finding => ({ id, status, detail });

function projectClip(value: unknown): NativeTimelineClip | null {
  if (!plain(value) || !text(value.id) || !text(value.mediaId) || !text(value.trackId) || !finite(value.start) || !finite(value.end)
    || !finite(value.sourceOffset) || value.start < 0 || value.end <= value.start || value.sourceOffset < 0
    || (value.role !== undefined && (typeof value.role !== 'string' || !['image', 'title', 'audio', 'video'].includes(value.role)))
    || (value.titleNonempty !== undefined && typeof value.titleNonempty !== 'boolean')
    || (value.titleTextDigest !== undefined && !sha256(value.titleTextDigest))) return null;
  const result: NativeTimelineClip = { id: value.id, mediaId: value.mediaId, trackId: value.trackId, start: value.start, end: value.end, sourceOffset: value.sourceOffset };
  if (value.role !== undefined) result.role = value.role as Clip['role'];
  if (value.titleNonempty !== undefined) result.titleNonempty = value.titleNonempty as boolean;
  if (sha256(value.titleTextDigest)) result.titleTextDigest = value.titleTextDigest.toLowerCase();
  return result;
}

function projectSnapshot(target: Target, action: string, raw: unknown): Snapshot | null {
  if (!plain(raw) || !Object.hasOwn(raw, 'contextId') || !text(raw.contextId) || !plain(raw.taskState)
    || !strings(raw.evidenceRefs) || raw.evidenceRefs.length === 0) return null;
  const state = raw.taskState;
  let projected: TaskState;
  if (target === 'blender') {
    if (!strings(state.selectedIds) || !plain(state.positions)
      || !Object.entries(state.positions).every(([id, coords]) => text(id) && vector(coords))
      || state.selectedIds.some(id => !Object.hasOwn(state.positions as object, id))) return null;
    projected = { selectedIds: [...state.selectedIds], positions: Object.fromEntries(Object.entries(state.positions).map(([id, coords]) => [id, [...coords as number[]]])) };
  } else {
    if (!Array.isArray(state.clips)) return null;
    const clips = [...state.clips].map(projectClip);
    if (clips.some(clip => clip === null) || new Set(clips.map(clip => clip!.id)).size !== clips.length) return null;
    if ((state.playheadSeconds !== undefined && (!finite(state.playheadSeconds) || state.playheadSeconds < 0))
      || (state.transport !== undefined && state.transport !== 'playing' && state.transport !== 'stopped')
      || (state.imageClipCount !== undefined && !count(state.imageClipCount))
      || (state.titleClipCount !== undefined && !count(state.titleClipCount))) return null;
    if (action === 'play' && (!finite(state.playheadSeconds) || (state.transport !== 'playing' && state.transport !== 'stopped'))) return null;
    projected = { clips: clips as Clip[] };
    if (finite(state.playheadSeconds)) projected.playheadSeconds = state.playheadSeconds;
    if (state.transport === 'playing' || state.transport === 'stopped') projected.transport = state.transport;
    if (count(state.imageClipCount)) projected.imageClipCount = state.imageClipCount;
    if (count(state.titleClipCount)) projected.titleClipCount = state.titleClipCount;
  }
  return { contextId: raw.contextId, taskState: projected, evidenceRefs: [...raw.evidenceRefs] };
}

function prepare(input: unknown): Preparation {
  if (!plain(input) || typeof input.target !== 'string' || !Object.hasOwn(actions, input.target)
    || typeof input.action !== 'string' || !actions[input.target as Target].includes(input.action)) {
    return { blocked: fail('native.action', 'blocked', 'Unsupported native target/action pair') };
  }
  const target = input.target as Target, action = input.action;
  const before = projectSnapshot(target, action, input.before), after = projectSnapshot(target, action, input.after);
  if (!before || !after) return { blocked: fail(`${target}.${action}.projection`, 'blocked', 'Both snapshots need a stable context ID, native evidence refs and complete valid task fields') };
  const observation: NativeCheckedObservation = {
    action,
    before: { ...before.taskState, contextId: before.contextId },
    after: { ...after.taskState, contextId: after.contextId },
    evidenceRefs: [...new Set([...before.evidenceRefs, ...after.evidenceRefs])],
  };
  return { prepared: { target, action, before, after, observation } };
}

function evaluate(prepared: Prepared): NativeCheckResult {
  const { target, action, before, after, observation } = prepared;
  const findings: Finding[] = [fail(`${target}.${action}.context`, before.contextId === after.contextId ? 'pass' : 'fail', 'Native scene/project identity is unchanged')];
  if (target === 'blender' && action === 'select') {
    const b = before.taskState.positions!, a = after.taskState.positions!, ids = Object.keys(b);
    const preserved = ids.length === Object.keys(a).length && ids.every(id => Object.hasOwn(a, id)
      && b[id].every((value, index) => Math.abs(value - a[id][index]) <= 1e-6));
    findings.push(fail('blender.select.positions', preserved ? 'pass' : 'fail', 'Selection preserves the complete observed object positions'));
  }
  if (action === 'play') {
    // Projection fixes key order. Compare by ID to tolerate native enumeration order,
    // but never discard unrelated clips or ignore an observed source/role change.
    const b = before.taskState.clips!, a = after.taskState.clips!;
    const preserved = b.length === a.length && b.every(clip => a.some(other => other.id === clip.id && JSON.stringify(clip) === JSON.stringify(other)));
    findings.push(fail(`${target}.play.clips`, preserved ? 'pass' : 'fail', 'Playback preserves the complete observed timeline'));
  }
  if (findings.some(item => item.status === 'fail')) return { status: 'fail', findings };
  const task = checkTask(target, observation);
  return { status: task.status, findings: [...findings, task], observation };
}

/** No launch, native mutation, timing, retry or desktop ownership. Main operation
 * semantics stay in checkTask; only observation mapping and extra preservation
 * guards are added here. A pass describes these supplied readbacks, not live coverage. */
export function validateNativeTask(input: NativeCheckInput | unknown): NativeCheckResult {
  const preparation = prepare(input);
  return 'blocked' in preparation ? { status: 'blocked', findings: [preparation.blocked] } : evaluate(preparation.prepared);
}

/** RunRecorder structurally implements this port. Artifact IDs are caller-chosen
 * per attempt; returned refs are kept exactly. Failed main task assertions can be
 * recorded for audit. Guard failures are saved as observation evidence but never
 * recorded as a weaker task that would omit the failing guard. Artifact-write
 * failure propagates; this helper does not retry or fabricate evidence.
 *
 * const result = await recordNativeTask(recorder, {
 *   target: 'reaper', action: 'split', before: nativeBefore, after: nativeAfter,
 * }, { before: 'reaper-split-before', after: 'reaper-split-after' });
 * // Resolve/adopt nativeBefore.evidenceRefs/nativeAfter.evidenceRefs with recorder
 * // before auditing; this helper never pretends those references already resolve.
 */
export async function recordNativeTask(recorder: NativeTaskRecorder, input: NativeCheckInput | unknown,
  artifactIds: { before: string; after: string }): Promise<NativeRecordedCheck> {
  const preparation = prepare(input);
  if ('blocked' in preparation) return { status: 'blocked', findings: [preparation.blocked], recorded: false, artifactRefs: [] };
  if (!artifactIds || !text(artifactIds.before) || !text(artifactIds.after) || artifactIds.before === artifactIds.after) {
    return { status: 'blocked', findings: [fail('native.artifact-ids', 'blocked', 'Two distinct native observation artifact IDs are required')], recorded: false, artifactRefs: [] };
  }
  const prepared = preparation.prepared;
  const beforeId = artifactIds.before, afterId = artifactIds.after;
  if (prepared.observation.evidenceRefs.includes(beforeId) || prepared.observation.evidenceRefs.includes(afterId)) {
    return { status: 'blocked', findings: [fail('native.artifact-ids', 'blocked', 'Projection artifact IDs must not replace existing native evidence references')], recorded: false, artifactRefs: [] };
  }
  // Preserve a single copied observation across asynchronous recorder writes.
  const result = evaluate(prepared);
  const beforeRef = await recorder.writeObservation(beforeId, prepared.before);
  const afterRef = await recorder.writeObservation(afterId, prepared.after);
  if (!text(beforeRef) || !text(afterRef) || beforeRef === afterRef
    || prepared.observation.evidenceRefs.includes(beforeRef) || prepared.observation.evidenceRefs.includes(afterRef)) throw new Error('NATIVE_OBSERVATION_REFS_INVALID');
  const artifactRefs = [beforeRef, afterRef];
  if (!result.observation || result.status === 'blocked') return { ...result, recorded: false, artifactRefs };
  const recordedObservation: NativeCheckedObservation = {
    ...result.observation, evidenceRefs: [...new Set([...result.observation.evidenceRefs, ...artifactRefs])],
  };
  recorder.recordTask(recordedObservation);
  return { ...result, observation: recordedObservation, recorded: true, artifactRefs };
}
