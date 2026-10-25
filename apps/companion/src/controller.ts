import { pairCompanion, randomToken, watchCompanion } from '@lucienne/session/companion';
import type { CompanionState, PairingPort, SubscriptionPort } from '@lucienne/session/companion';

export interface CompanionPorts { pairing: PairingPort; subscription: SubscriptionPort }
export interface PrivateStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
type SavedPair = { version: 1; readerToken: string; pairingToken?: string };
export interface DisplayState {
  status: 'unconfigured' | 'pairing' | CompanionState['status'];
  busy: boolean;
  retryPairing: boolean;
  reconnect: boolean;
  problem: 'pairing' | 'storage' | 'invalid-code' | 'connection' | null;
  session: CompanionState | null;
}
const storageKey = 'lucienne.companion.reader.v1';
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const empty = (status: DisplayState['status']): DisplayState => ({ status, busy: false, retryPairing: false, reconnect: false, problem: null, session: null });

/** Connection lifecycle only. The session service watcher owns cursor/staleness; host owns run timing. */
export function createCompanionController(ports?: CompanionPorts, storage?: PrivateStorage) {
  let state = empty(ports ? 'pairing' : 'unconfigured');
  let saved: SavedPair | null = null, generation = 0, disposed = false;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const emit = (next: DisplayState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const detach = () => { generation++; const previous = stop; stop = undefined; previous?.(); };
  const persist = (value: SavedPair | null) => {
    if (storage) { if (value) storage.setItem(storageKey, JSON.stringify(value)); else storage.removeItem(storageKey); }
    saved = value;
  };
  const storageFailure = () => emit({ ...empty('error'), problem: 'storage', retryPairing: !!saved?.pairingToken });
  const connect = () => {
    if (disposed || !ports || !saved || saved.pairingToken) return;
    detach(); const active = generation;
    emit(empty('connecting'));
    try {
      const unsubscribe = watchCompanion(ports.subscription, saved.readerToken, session => {
        if (disposed || active !== generation) return;
        // Some stable watcher versions retain latest while stale. Never display it.
        const safe = session.status === 'live' ? session : { ...session, latest: null, events: [] };
        emit({ ...empty(session.status), reconnect: session.status === 'error' || session.status === 'stale', session: safe });
      });
      if (disposed || active !== generation) unsubscribe(); else stop = unsubscribe;
    } catch { emit({ ...empty('error'), reconnect: true, problem: 'connection' }); }
  };
  const redeem = async () => {
    if (disposed || !ports || !saved?.pairingToken || state.busy) return;
    detach(); const active = generation, attempt = saved;
    emit({ ...empty('pairing'), busy: true });
    try {
      await pairCompanion(ports.pairing, attempt.pairingToken!, attempt.readerToken);
      if (disposed || active !== generation) return;
      try { persist({ version: 1, readerToken: attempt.readerToken }); }
      catch { storageFailure(); return; }
      connect();
    } catch {
      if (!disposed && active === generation) emit({ ...empty('error'), retryPairing: true, problem: 'pairing' });
    }
  };
  if (ports) {
    try {
      const raw = storage?.getItem(storageKey);
      if (raw) {
        const value = JSON.parse(raw) as SavedPair;
        if (value.version !== 1 || !isToken(value.readerToken) || (value.pairingToken !== undefined && !isToken(value.pairingToken))) throw new Error();
        saved = value;
        if (saved.pairingToken) state = { ...empty('pairing'), retryPairing: true };
        else connect();
      }
    } catch { state = { ...empty('error'), problem: 'storage' }; }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async pair(input: string) {
      if (disposed || !ports || state.busy) return;
      const token = input.trim();
      if (!isToken(token)) { emit({ ...empty('pairing'), problem: 'invalid-code', retryPairing: !!saved?.pairingToken }); return; }
      // A retry of the same unresolved code must retain its reader identity.
      const attempt = saved?.pairingToken === token ? saved : { version: 1 as const, readerToken: randomToken(), pairingToken: token };
      detach();
      try { persist(attempt); } catch { storageFailure(); return; }
      await redeem();
    },
    retryPairing: redeem,
    reconnect: connect,
    forget() {
      if (disposed) return;
      detach();
      try { persist(null); emit(empty(ports ? 'pairing' : 'unconfigured')); } catch { storageFailure(); }
    },
    dispose() { if (disposed) return; detach(); disposed = true; listeners.clear(); saved = null; },
  };
}
export type CompanionController = ReturnType<typeof createCompanionController>;
