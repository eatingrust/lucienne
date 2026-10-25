import type { RunEvent } from '../../../contracts/index.js';
import { projectEvent } from './projection.js';
import type { PairingPort, SubscriptionPort } from './ports.js';

export async function pairCompanion(port: PairingPort, pairingToken: string, readerToken: string) {
  // Caller retains readerToken for uncertain-response retry; never persist it in a URL/query log.
  const result = await port.call('pair', { pairingToken, readerToken });
  return { readerToken, streamId: result.streamId as string, expiresAt: result.expiresAt as number };
}
export type CompanionState = { status: 'connecting' | 'live' | 'stale' | 'expired' | 'error';
  latest: RunEvent | null; cursor: number; gap: boolean; events: RunEvent[] };
/** Only displays snapshots. It never sends native commands or owns the local timer. */
export function watchCompanion(port: SubscriptionPort, readerToken: string,
  onState: (state: CompanionState) => void, clock = () => Date.now()): () => void {
  let cursor = 0, streamId: string | undefined, stopped = false, lastReceived = 0, lastServerAt = 0, expires = 0, recovering = false;
  const connectingAt = clock();
  let state: CompanionState = { status: 'connecting', latest: null, cursor: 0, gap: false, events: [] };
  const emit = (value: CompanionState) => { state = value; try { onState(value); } catch { /* Observer isolation. */ } };
  emit(state);
  const unsubscribe = port.subscribe({ readerToken, after: 0 }, view => {
    if (stopped) return;
    try {
      if (view.readerExpiresAt <= clock()) { emit({ ...state, status: 'expired', latest: null, events: [] }); return; }
      if (streamId && streamId !== view.streamId) { emit({ ...state, status: 'error', latest: null, events: [] }); return; }
      const initial = streamId === undefined || recovering;
      streamId = view.streamId;
      if (view.cursor < cursor) return;
      const gap = view.oldestCursor > cursor + 1;
      const events = view.events.filter(e => e.cursor > cursor).map(e => projectEvent(e.event));
      cursor = view.cursor; lastReceived = clock(); lastServerAt = view.serverAt; expires = view.readerExpiresAt; recovering = false;
      const latest = view.events.at(-1);
      const stale = clock() - lastServerAt > 30_000;
      emit({ status: stale ? 'stale' : 'live', latest: !stale && latest ? projectEvent(latest.event) : null,
        cursor, gap, events: (initial || gap || stale) ? [] : events });
    } catch {
      recovering = true;
      emit({ ...state, status: 'error', latest: null, events: [] });
    }
  }, () => { if (!stopped) { recovering = true; emit({ ...state, status: 'error', latest: null, events: [] }); } });
  const timer = setInterval(() => {
    if (stopped || state.status === 'expired' || state.status === 'error') return;
    if (expires && expires <= clock()) emit({ ...state, status: 'expired', latest: null, events: [] });
    else if ((!lastReceived && clock() - connectingAt > 30_000) || (lastReceived && (clock() - lastReceived > 30_000 || clock() - lastServerAt > 30_000))) emit({ ...state, status: 'stale', latest: null, events: [] });
  }, 1_000);
  timer.unref?.();
  return () => { if (stopped) return; stopped = true; clearInterval(timer); unsubscribe(); };
}
