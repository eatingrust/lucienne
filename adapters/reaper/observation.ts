import path from 'node:path';
import { z } from 'zod';
import type { NativeTaskSnapshot, PlaybackTaskState } from '../../qa/native-checks.js';

const guid = z.string().regex(/^\{[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\}$/);
const nativeText = z.string().min(1).max(4096).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const seconds = z.number().finite().nonnegative();
const item = z.object({
  itemGuid: guid, trackGuid: guid, sourceFile: nativeText, sourceType: z.literal('WAV'),
  sourceHasParent: z.literal(false), mediaId: nativeText, playRate: z.literal(1),
  position: seconds, length: z.number().finite().positive(), sourceOffset: seconds,
  selected: z.boolean(), sourceOnline: z.literal(true),
}).passthrough();
/** Wire data remains separate from native QA's shared task contract. These fields must
 * come from REAPER's API and the owned runtime, never a request or prepared patch. */
export const ReaperObservationSchema = z.object({
  projectHandle: nativeText, projectMasterTrackGuid: guid, projectContextId: nativeText,
  projectItemCount: z.number().int().nonnegative(), trackCount: z.literal(1), trackGuid: guid,
  items: z.array(item), playState: z.number().int().min(0).max(3), playPosition: seconds, cursor: seconds,
  nativeProcess: z.object({ pid: z.number().int().positive(), executable: nativeText }),
  evidenceRefs: z.array(z.string().regex(/^[a-zA-Z0-9._:/-]{1,160}$/)).min(1),
}).passthrough();
export type ReaperObservation = z.infer<typeof ReaperObservationSchema>;

/** Pure projection into the existing shared QA type. No launch, mutation,
 * filtering, task verdict or fabricated evidence. Invalid/unsupported native
 * state fails closed; the original observation artifact remains inspectable. */
export function projectReaperTaskObservation(value: unknown): NativeTaskSnapshot<PlaybackTaskState> {
  const observed = ReaperObservationSchema.parse(value);
  if (observed.projectContextId !== `${observed.projectHandle}:${observed.projectMasterTrackGuid}`)
    throw new Error('REAPER_TASK_PROJECT_IDENTITY');
  if (!path.isAbsolute(observed.nativeProcess.executable) || path.basename(observed.nativeProcess.executable) !== 'REAPER')
    throw new Error('REAPER_TASK_PROCESS_IDENTITY');
  if (observed.items.length !== observed.projectItemCount || new Set(observed.items.map(clip => clip.itemGuid)).size !== observed.items.length)
    throw new Error('REAPER_TASK_INCOMPLETE_ITEMS');
  if (new Set(observed.evidenceRefs).size !== observed.evidenceRefs.length)
    throw new Error('REAPER_TASK_EVIDENCE_REFS');
  const clips = observed.items.map(clip => {
    if (clip.trackGuid !== observed.trackGuid || !path.isAbsolute(clip.sourceFile)
      || clip.mediaId !== `${clip.sourceType}:${clip.sourceFile}`)
      throw new Error('REAPER_TASK_CLIP_IDENTITY');
    const end = clip.position + clip.length;
    if (!Number.isFinite(end) || end <= clip.position) throw new Error('REAPER_TASK_CLIP_RANGE');
    return { id: clip.itemGuid, mediaId: clip.mediaId, trackId: clip.trackGuid,
      start: clip.position, end, sourceOffset: clip.sourceOffset, role: 'audio' as const };
  });
  return {
    // REAPER handles are process-local. The observed native master-track GUID
    // disambiguates project reuse; the real owned PID scopes the native handle.
    contextId: `reaper:${observed.nativeProcess.pid}:${observed.projectContextId}`,
    taskState: { clips, playheadSeconds: observed.playState === 0 ? observed.cursor : observed.playPosition,
      transport: (observed.playState & 1) !== 0 && (observed.playState & 2) === 0 ? 'playing' : 'stopped' },
    evidenceRefs: [...observed.evidenceRefs],
  };
}
