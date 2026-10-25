import type { TargetApp } from './matrix.ts';

/** QA observer projections, not adapter/patch contracts. Capture from native readback,
 * never from the desired patch. The run bundle binds each observation to hashed evidence. */
export interface Clip {
  id: string; mediaId: string; start: number; end: number; sourceOffset: number;
  /** Native track identity; optional only for older standalone fixture observations. */
  trackId?: string;
  /** Native project/media readback, not a label inferred from the requested task. */
  role?: 'image' | 'title' | 'audio' | 'video';
  titleNonempty?: boolean;
  /** SHA256 of decoded visible native text only (NFC, LF, UTF-8), excluding XML/style/geometry.
   * mediaId remains the native title identity and must not be this text hash. */
  titleTextDigest?: string;
}
export interface TaskState {
  selectedIds?: string[];
  positions?: Record<string, readonly number[]>;
  pixelDigest?: string;
  selectionPixels?: number;
  selectionDigest?: string;
  layerId?: string;
  bounds?: readonly number[];
  clips?: Clip[];
  playheadSeconds?: number;
  transport?: 'playing' | 'stopped';
  /** Optional cross-checks only. Per-clip native roles are required for montage proof. */
  imageClipCount?: number;
  titleClipCount?: number;
}
export interface TaskObservation {
  action: string; before: TaskState; after: TaskState; evidenceRefs: string[];
}
export interface Finding { id: string; status: 'pass' | 'fail' | 'blocked'; detail: string }
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const count = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v >= 0;
const strings = (v: unknown): v is string[] => Array.isArray(v) && [...v].every(text) && new Set(v).size === v.length;
const vector = (v: unknown, length: number): v is number[] => Array.isArray(v) && v.length === length && [...v].every(finite);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6;
const validClips = (v: unknown): v is Clip[] => Array.isArray(v) && [...v].every(c =>
  record(c) && text(c.id) && text(c.mediaId) && finite(c.start) && finite(c.end) && finite(c.sourceOffset) &&
  c.start >= 0 && c.end > c.start && c.sourceOffset >= 0 &&
  (c.trackId === undefined || text(c.trackId)) &&
  (c.role === undefined || (typeof c.role === 'string' && ['image','title','audio','video'].includes(c.role))) &&
  (c.titleNonempty === undefined || typeof c.titleNonempty === 'boolean') &&
  (c.titleTextDigest === undefined || digest(c.titleTextDigest))) && new Set(v.map(c => c.id)).size === v.length;
const sameMedia = (a: Clip, b: Clip) => a.mediaId === b.mediaId && a.trackId === b.trackId && a.role === b.role &&
  a.titleNonempty === b.titleNonempty && a.titleTextDigest?.toLowerCase() === b.titleTextDigest?.toLowerCase();
const sameClip = (a: Clip, b: Clip) => a.id === b.id && sameMedia(a,b) &&
  close(a.start,b.start) && close(a.end,b.end) && close(a.sourceOffset,b.sourceOffset);
const sameTimeline = (a: Clip[], b: Clip[]) => a.length === b.length && a.every(c => b.some(other => sameClip(c,other)));
const positionMap = (v: unknown): v is Record<string, number[]> => record(v) &&
  Object.entries(v).every(([id,coordinates]) => text(id) && vector(coordinates,3));
const sameVector = (a: number[], b: number[]) => a.every((value,i) => close(value,b[i]));

export function checkTask(target: TargetApp, o: unknown): Finding {
  const action = record(o) && text(o.action) ? o.action : 'unknown';
  const id = `${target}.${action}`;
  const blocked = (detail: string): Finding => ({ id, status: 'blocked', detail });
  const verdict = (passed: boolean, detail: string): Finding => ({ id, status: passed ? 'pass' : 'fail', detail });
  if (!record(o) || !text(o.action) || !record(o.before) || !record(o.after)) return blocked('Native task observation is malformed');
  const b = o.before, a = o.after;
  if (!strings(o.evidenceRefs) || !o.evidenceRefs.length) return blocked('Native before/after evidence is missing or invalid');
  if (action === 'select' && target === 'blender') {
    if (!strings(b.selectedIds) || !strings(a.selectedIds)) return blocked('Selection readback is missing or invalid');
    const previous = b.selectedIds;
    return verdict(a.selectedIds.length > 0 && a.selectedIds.some(id => !previous.includes(id)), 'A distinct object becomes selected');
  }
  if (action === 'move' && target === 'blender') {
    if (!positionMap(b.positions) || !positionMap(a.positions) || !strings(b.selectedIds) || !b.selectedIds.length) return blocked('Selected object 3D position readback is missing or invalid');
    const beforePositions = b.positions, afterPositions = a.positions;
    const selected = b.selectedIds;
    if (selected.some(id => !Object.hasOwn(beforePositions,id) || !Object.hasOwn(afterPositions,id))) return blocked('Selected-object position vectors are incomplete');
    const beforeIds = Object.keys(beforePositions), afterIds = Object.keys(afterPositions);
    const objectsConserved = beforeIds.length === afterIds.length && beforeIds.every(id => Object.hasOwn(afterPositions,id));
    const unselectedConserved = beforeIds.filter(id => !selected.includes(id)).every(id => Object.hasOwn(afterPositions,id) && sameVector(beforePositions[id],afterPositions[id]));
    const moved = selected.some(id => !sameVector(beforePositions[id],afterPositions[id]));
    return verdict(objectsConserved && unselectedConserved && moved, 'A selected object moves while observed unselected objects remain unchanged');
  }
  if (action === 'paint' && target === 'krita') {
    if (!digest(b.pixelDigest) || !digest(a.pixelDigest)) return blocked('Canvas pixel digests are missing');
    return verdict(b.pixelDigest.toLowerCase() !== a.pixelDigest.toLowerCase(), 'Rendered canvas pixels change after painting');
  }
  if (action === 'select' && target === 'krita') {
    if (!count(b.selectionPixels) || !count(a.selectionPixels) || (b.selectionDigest !== undefined && !digest(b.selectionDigest)) || (a.selectionDigest !== undefined && !digest(a.selectionDigest))) return blocked('Native selection pixel readback is missing or invalid');
    const maskChanged = digest(b.selectionDigest) && digest(a.selectionDigest) && b.selectionDigest.toLowerCase() !== a.selectionDigest.toLowerCase();
    return verdict(a.selectionPixels > 0 && (a.selectionPixels !== b.selectionPixels || maskChanged), 'A nonempty native selection changes its size or mask');
  }
  if (action === 'transform' && target === 'krita') {
    if (!text(b.layerId) || !text(a.layerId) || !vector(b.bounds,4) || !vector(a.bounds,4) || b.bounds[2] <= 0 || b.bounds[3] <= 0 || a.bounds[2] <= 0 || a.bounds[3] <= 0) return blocked('Layer identity and positive before/after bounds are missing or invalid');
    return verdict(b.layerId === a.layerId && !sameVector(b.bounds,a.bounds), 'The same layer has changed nonempty bounds');
  }
  if (target === 'reaper' || target === 'kdenlive') {
    if (action === 'play') {
      if (!finite(b.playheadSeconds) || !finite(a.playheadSeconds) || (a.transport !== 'playing' && a.transport !== 'stopped')) return blocked('Transport/playhead readback is missing or invalid');
      return verdict(b.playheadSeconds >= 0 && a.playheadSeconds > b.playheadSeconds && a.transport === 'playing', 'Playback advances the native playhead');
    }
    if (action === 'split' || action === 'cut') {
      if (!validClips(b.clips) || !validClips(a.clips)) return blocked('Timeline clip readback is missing or invalid');
      const before = b.clips, after = a.clips;
      // Exactly one source interval is replaced; all remaining observed clips must be conserved.
      const splits = before.some(old => after.some(left => after.some(right =>
        left.id !== right.id && sameMedia(left,old) && sameMedia(right,old) &&
        close(left.start, old.start) && close(left.end, right.start) && close(right.end, old.end) &&
        close(left.sourceOffset, old.sourceOffset) && close(right.sourceOffset, old.sourceOffset + left.end - left.start) &&
        sameTimeline(before.filter(c => c.id !== old.id),after.filter(c => c.id !== left.id && c.id !== right.id)))));
      return verdict(after.length === before.length + 1 && splits, 'One clip splits into contiguous source-preserving intervals; other clips are unchanged');
    }
    if (action === 'trim') {
      if (!validClips(b.clips) || !validClips(a.clips)) return blocked('Timeline clip readback is missing or invalid');
      const before = b.clips, after = a.clips;
      const trims = before.some(old => after.some(c => c.id === old.id && sameMedia(c,old) &&
        c.start >= old.start && c.end <= old.end && c.end - c.start < old.end - old.start && !close(c.end-c.start,old.end-old.start) &&
        close(c.sourceOffset, old.sourceOffset + c.start - old.start) &&
        sameTimeline(before.filter(other => other.id !== old.id),after.filter(other => other.id !== old.id))));
      return verdict(trims, 'One clip shortens without changing its source; all other observed clips are unchanged');
    }
    if (action === 'montage-title' && target === 'kdenlive') {
      if (!validClips(b.clips) || !validClips(a.clips)
        || [...b.clips,...a.clips].some(c => c.role === undefined || !text(c.trackId))) return blocked('Complete montage/title before/after clips need native roles and stable track identities');
      const before = b.clips, after = a.clips;
      const beforeImages = before.filter(c => c.role === 'image'), beforeTitles = before.filter(c => c.role === 'title');
      const images = after.filter(c => c.role === 'image'), titles = after.filter(c => c.role === 'title');
      if ([...beforeTitles,...titles].some(c => !digest(c.titleTextDigest) || typeof c.titleNonempty !== 'boolean')) return blocked('Existing native titles need before/after decoded text digests and nonempty readback');
      if ([b,a].some(state => (state.imageClipCount !== undefined && !count(state.imageClipCount)) || (state.titleClipCount !== undefined && !count(state.titleClipCount)))) return blocked('Montage/title count cross-checks are malformed');
      if (beforeImages.length < 2 || beforeTitles.length === 0) return verdict(false, 'This task requires editing an existing prepared image montage and native title');
      const countsAgree = (b.imageClipCount === undefined || b.imageClipCount === beforeImages.length)
        && (b.titleClipCount === undefined || b.titleClipCount === beforeTitles.length)
        && (a.imageClipCount === undefined || a.imageClipCount === images.length)
        && (a.titleClipCount === undefined || a.titleClipCount === titles.length);
      const perTrack = (clips: Clip[]) => {
        const tracks = new Map<string,Clip[]>();
        for (const c of clips) tracks.set(c.trackId!,[...(tracks.get(c.trackId!) ?? []),c]);
        for (const clips of tracks.values()) clips.sort((left,right) => left.start-right.start);
        return tracks;
      };
      const nonoverlapping = (clips: Clip[]) => [...perTrack(clips).values()].every(track =>
        track.every((c,i) => i === 0 || c.start >= track[i-1].end || close(c.start,track[i-1].end)));
      const titleOverImage = (title: Clip) => title.titleNonempty === true && digest(title.titleTextDigest)
        && title.titleTextDigest.toLowerCase() !== 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        && images.some(image => Math.max(image.start,title.start) < Math.min(image.end,title.end));
      const editedTitle = (old: Clip, next: Clip) => old.role === 'title' && next.role === 'title'
        && old.id === next.id && old.mediaId === next.mediaId && old.trackId === next.trackId
        && close(old.start,next.start) && close(old.end,next.end) && close(old.sourceOffset,next.sourceOffset)
        && old.titleTextDigest!.toLowerCase() !== next.titleTextDigest!.toLowerCase() && titleOverImage(next);
      const preserved = before.length === after.length && before.every(old => {
        const next = after.find(c => c.id === old.id);
        if (!next) return false;
        if (old.role === 'image') return sameMedia(old,next) && close(old.end-old.start,next.end-next.start) && close(old.sourceOffset,next.sourceOffset);
        if (editedTitle(old,next)) return true;
        return sameClip(old,next);
      });
      const reordered = beforeImages.some(left => beforeImages.some(right => {
        if (left.mediaId === right.mediaId || left.trackId !== right.trackId || left.end > right.start) return false;
        const nextLeft = images.find(c => c.id === left.id), nextRight = images.find(c => c.id === right.id);
        return !!nextLeft && !!nextRight && nextRight.end <= nextLeft.start;
      }));
      const beforeOrder = perTrack(beforeImages), afterOrder = perTrack(images);
      const mediaOrderChanged = [...beforeOrder].some(([trackId,clips]) => {
        const next = afterOrder.get(trackId);
        return !!next && JSON.stringify(clips.map(c => c.mediaId)) !== JSON.stringify(next.map(c => c.mediaId));
      });
      const titleEdited = beforeTitles.some(old => titles.some(next => editedTitle(old,next)));
      return verdict(countsAgree && preserved && nonoverlapping(beforeImages) && nonoverlapping(images) && reordered && mediaOrderChanged && titleEdited,
        'Existing stills change relative order on the same track and the same native title receives nonempty edited text; unrelated clips are preserved');
    }
  }
  return blocked('No approved assertion for this target/action');
}
