import { SenderError, setGlobalLogLevel } from 'spacetimedb';
import { DbConnection } from '../spacetime/bindings/index.js';
import { assertToken, MAX_EVENTS, randomToken } from './capabilities.js';
import { projectEvent, type SessionView } from './projection.js';

export interface SpacetimeOptions {
  /** TLS is required except for an explicit loopback development server. */
  uri: string;
  databaseName: string;
  /** Private Spacetime identity credential, distinct from the reader capability. */
  authToken?: string;
  /** Persist before any command is sent. Reuse this token after recreation. */
  onToken?: (token: string) => void | Promise<void>;
}

export type SpacetimeErrorCode = 'UNAUTHORIZED' | 'STALE_STREAM' | 'INVALID_EVENT' |
  'SEQUENCE_GAP' | 'CONFLICT' | 'INVALID_ARGUMENT' | 'PAIRING_EXPIRED' |
  'SERVICE_ERROR' | 'TIMEOUT' | 'OFFLINE' | 'CLOSED' | 'QUEUE_FULL' | 'TOKEN_PERSISTENCE';
const serverErrors = new Set<SpacetimeErrorCode>([
  'UNAUTHORIZED', 'STALE_STREAM', 'INVALID_EVENT', 'SEQUENCE_GAP', 'CONFLICT',
  'INVALID_ARGUMENT', 'PAIRING_EXPIRED', 'SERVICE_ERROR',
]);
export class SpacetimeTransportError extends Error {
  constructor(readonly code: SpacetimeErrorCode) {
    super(code);
    this.name = 'SpacetimeTransportError';
  }
}

const DEADLINE_MS = 8_000;
const MAX_PENDING = 32;
const MAX_REQUEST_JSON = 131_072;
const MAX_JSON = 1_048_576;
type Ack = { requestId: string; resultJson: string; errorCode: string };
type ConnectionState = {
  connection?: DbConnection;
  ready: Promise<DbConnection>;
  resolveReady: (connection: DbConnection) => void;
  rejectReady: (error: SpacetimeTransportError) => void;
  authReady: Promise<void>;
  online: boolean;
  revision: number;
  dispose: () => void;
  disposed: boolean;
};
type Pending = {
  requestId: string;
  state: ConnectionState;
  resolve: (value: unknown) => void;
  reject: (error: SpacetimeTransportError) => void;
};

function failure(code: SpacetimeErrorCode): SpacetimeTransportError {
  return new SpacetimeTransportError(code);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
export function validateSpacetimeOptions(options: SpacetimeOptions): void {
  try {
    const url = new URL(options.uri);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!['https:', 'wss:'].includes(url.protocol) && !(local && ['http:', 'ws:'].includes(url.protocol))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(options.databaseName) ||
      (options.authToken !== undefined && (typeof options.authToken !== 'string' || options.authToken.length < 1 || options.authToken.length > 16_384))) {
      throw failure('INVALID_ARGUMENT');
    }
  } catch { throw failure('INVALID_ARGUMENT'); }
}

/** Parse the canonical event contract; never trust a transport JSON cast. */
export function parseSpacetimeView(json: string, after: number): SessionView {
  try {
    if (typeof json !== 'string' || json.length > MAX_JSON || !counter(after)) throw failure('SERVICE_ERROR');
    const value: unknown = JSON.parse(json);
    if (!record(value) || typeof value.streamId !== 'string' || !/^[a-f0-9]{64}$/.test(value.streamId) ||
      !counter(value.cursor) || !counter(value.serverAt) || !counter(value.readerExpiresAt) ||
      !counter(value.oldestCursor) || typeof value.gap !== 'boolean' ||
      !Array.isArray(value.events) || value.events.length > MAX_EVENTS) throw failure('SERVICE_ERROR');
    let last = 0;
    const events = value.events.map((item: unknown) => {
      if (!record(item) || !counter(item.cursor) || item.cursor <= last || item.cursor > (value.cursor as number)) throw failure('SERVICE_ERROR');
      last = item.cursor;
      return { cursor: item.cursor, event: projectEvent(item.event) };
    });
    if (value.oldestCursor !== (events[0]?.cursor ?? value.cursor + 1) ||
      (events.length > 0 && events.at(-1)!.cursor !== value.cursor)) throw failure('SERVICE_ERROR');
    return {
      streamId: value.streamId, cursor: value.cursor, events, serverAt: value.serverAt,
      readerExpiresAt: value.readerExpiresAt, oldestCursor: value.oldestCursor,
      gap: after < value.oldestCursor - 1,
    };
  } catch { throw failure('SERVICE_ERROR'); }
}

/** Internal connection owner. Public companion entrypoint exposes only pair/read. */
export class SpacetimeRuntime {
  private token: string | undefined;
  private state: ConnectionState | undefined;
  private pending: Pending | undefined;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private readonly options: Readonly<SpacetimeOptions>;
  private readonly disconnected = new Set<(terminal: boolean) => void>();

  constructor(options: SpacetimeOptions) {
    validateSpacetimeOptions(options);
    this.options = { ...options };
    this.token = options.authToken;
    // SDK trace logging serializes reducer arguments, which contain capabilities.
    setGlobalLogLevel('error');
  }
  getAuthToken(): string | undefined { return this.token; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.drop(this.state, 'CLOSED');
  }
  private drop(state: ConnectionState | undefined, code: SpacetimeErrorCode): void {
    if (!state || state.disposed) return;
    state.disposed = true;
    if (this.state === state) this.state = undefined;
    state.rejectReady(failure(code));
    if (this.pending?.state === state) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(failure(code));
    }
    state.dispose();
    try { state.connection?.disconnect(); } catch { /* No provider error text escapes. */ }
    for (const listener of [...this.disconnected]) listener(true);
  }
  private connectionLost(state: ConnectionState, nextAttempt?: number): void {
    if (state.disposed) return;
    if (nextAttempt === undefined) { this.drop(state, 'OFFLINE'); return; }
    state.revision++;
    if (state.online) {
      state.online = false;
      state.ready = new Promise<DbConnection>((resolve, reject) => {
        state.resolveReady = resolve;
        state.rejectReady = reject;
      });
      // A passive watcher may reconnect without any command waiting for readiness.
      void state.ready.catch(() => {});
    }
    if (this.pending?.state === state) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(failure('OFFLINE'));
    }
    for (const listener of [...this.disconnected]) listener(false);
  }
  private accept(state: ConnectionState, ack: Ack): void {
    const pending = this.pending;
    if (state.disposed || !pending || pending.state !== state || pending.requestId !== ack.requestId) return;
    this.pending = undefined;
    if (ack.errorCode) {
      pending.reject(failure(serverErrors.has(ack.errorCode as SpacetimeErrorCode) ? ack.errorCode as SpacetimeErrorCode : 'SERVICE_ERROR'));
      return;
    }
    try {
      if (typeof ack.resultJson !== 'string' || ack.resultJson.length > MAX_JSON) throw failure('SERVICE_ERROR');
      pending.resolve(JSON.parse(ack.resultJson));
    } catch { pending.reject(failure('SERVICE_ERROR')); }
  }
  private connect(): Promise<DbConnection> {
    if (this.closed) return Promise.reject(failure('CLOSED'));
    if (this.state) return this.state.ready;
    let resolveReady!: (connection: DbConnection) => void;
    let rejectReady!: (error: SpacetimeTransportError) => void;
    const ready = new Promise<DbConnection>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const state: ConnectionState = { ready, resolveReady, rejectReady, authReady: Promise.resolve(),
      online: false, revision: 0, disposed: false, dispose: () => {} };
    void ready.catch(() => {});
    this.state = state;
    const timer = setTimeout(() => this.drop(state, 'TIMEOUT'), DEADLINE_MS);
    state.dispose = () => clearTimeout(timer);
    try {
      state.connection = DbConnection.builder()
        .withUri(this.options.uri).withDatabaseName(this.options.databaseName)
        .withToken(this.token).withConfirmedReads(true)
        .withAutomaticReconnect({ minDelayMs: 1_000, maxDelayMs: 30_000 })
        .onConnect((connection, _identity, token) => {
          void (async () => {
            if (state.disposed) return;
            this.token = token;
            try { await this.options.onToken?.(token); }
            catch { this.drop(state, 'TOKEN_PERSISTENCE'); return; }
            if (state.disposed) return;
            const onInsert = (_ctx: unknown, row: Ack) => this.accept(state, row);
            const onUpdate = (_ctx: unknown, _old: Ack, row: Ack) => this.accept(state, row);
            connection.db.ownerAck.onInsert(onInsert);
            connection.db.ownerAck.onUpdate(onUpdate);
            const subscription = connection.subscriptionBuilder()
              .onApplied(() => {
                const revision = state.revision;
                void state.authReady.then(() => {
                  clearTimeout(timer);
                  if (!state.disposed && state.revision === revision) { state.online = true; state.resolveReady(connection); }
                }).catch(() => this.drop(state, 'TOKEN_PERSISTENCE'));
              })
              .onError(() => this.drop(state, 'OFFLINE'))
              .subscribe('SELECT * FROM owner_ack');
            state.dispose = () => {
              clearTimeout(timer);
              connection.db.ownerAck.removeOnInsert(onInsert);
              connection.db.ownerAck.removeOnUpdate(onUpdate);
              try { subscription.unsubscribe(); } catch { /* Connection may already be gone. */ }
            };
          })().catch(() => this.drop(state, 'SERVICE_ERROR'));
        })
        .onAutomaticReconnect((_connection, _identity, token) => {
          this.token = token;
          state.authReady = Promise.resolve().then(() => this.options.onToken?.(token));
          void state.authReady.catch(() => this.drop(state, 'TOKEN_PERSISTENCE'));
        })
        .onConnectError((_ctx, _error, nextAttempt) => this.connectionLost(state, nextAttempt))
        .onDisconnect((_ctx, _error, nextAttempt) => this.connectionLost(state, nextAttempt))
        .build();
    } catch { this.drop(state, 'OFFLINE'); }
    return ready;
  }

  /** Serialize ACK consumption. A timeout is an unknown outcome, never success. */
  call(op: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(failure('CLOSED'));
    if (this.queued >= MAX_PENDING) return Promise.reject(failure('QUEUE_FULL'));
    let argsJson: string;
    try {
      argsJson = JSON.stringify(args);
      if (argsJson.length > MAX_REQUEST_JSON) throw failure('INVALID_ARGUMENT');
    } catch { return Promise.reject(failure('INVALID_ARGUMENT')); }
    this.queued++;
    let finished = false;
    let activeState: ConnectionState | undefined;
    let resolve!: (value: unknown) => void;
    let reject!: (error: SpacetimeTransportError) => void;
    const result = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    const finish = (error?: SpacetimeTransportError, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.queued--;
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(failure('TIMEOUT'));
      if (activeState) this.drop(activeState, 'TIMEOUT');
    }, DEADLINE_MS);
    const execute = async () => {
      if (finished) return;
      if (this.closed) { finish(failure('CLOSED')); return; }
      try {
        const connecting = this.connect();
        activeState = this.state;
        const connection = await connecting;
        if (finished || !activeState || activeState.disposed) return;
        const state = activeState;
        const requestId = randomToken();
        const acknowledged = new Promise<unknown>((res, rej) => {
          this.pending = { requestId, state, resolve: res, reject: rej };
        });
        // Register the ACK waiter before sending. Reducer completion alone is insufficient.
        void Promise.resolve().then(() => connection.reducers.command({ requestId, op, argsJson })).catch(error => {
          if (this.pending?.requestId !== requestId) return;
          if (error instanceof SenderError && serverErrors.has(error.message as SpacetimeErrorCode)) {
            const pending = this.pending;
            this.pending = undefined;
            pending.reject(failure(error.message as SpacetimeErrorCode));
          } else this.drop(state, 'SERVICE_ERROR');
        });
        finish(undefined, await acknowledged);
      } catch (error) {
        finish(error instanceof SpacetimeTransportError ? error : failure('SERVICE_ERROR'));
      }
    };
    this.tail = this.tail.then(execute, execute);
    return result;
  }

  subscribe(args: { readerToken: string; after: number }, update: (view: SessionView) => void, error: () => void): () => void {
    args = { readerToken: args.readerToken, after: args.after };
    let stopped = false;
    let applied = false;
    let scheduled = false;
    let epoch = 0;
    let firstApplied = true;
    let cleanup = () => {};
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      this.disconnected.delete(onDisconnect);
      cleanup();
    };
    const fail = () => { if (!stopped) { stop(); try { error(); } catch { /* Observer only. */ } } };
    const onDisconnect = (terminal: boolean) => {
      if (terminal) { fail(); return; }
      epoch++;
      applied = false;
      // Preserve the SDK subscription, but immediately clear the visible snapshot.
      if (!stopped) { try { error(); } catch { /* Observer only. */ } }
    };
    const timer = setTimeout(fail, DEADLINE_MS);
    this.disconnected.add(onDisconnect);
    void (async () => {
      assertToken(args.readerToken);
      if (!counter(args.after)) throw failure('INVALID_ARGUMENT');
      // A retained SDK identity alone is insufficient: prove the reader capability.
      await this.call('read', args);
      if (stopped) return;
      const connection = await this.connect();
      if (stopped) return;
      const emit = () => {
        if (stopped || !applied || scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          if (stopped || !applied) return;
          let view: SessionView;
          try {
            const rows = [...connection.db.sessionSnapshot.iter()];
            if (rows.length !== 1) throw failure('UNAUTHORIZED');
            view = parseSpacetimeView(rows[0]!.viewJson, args.after);
          } catch { fail(); return; }
          try { update(view); } catch { /* Observer code cannot break SDK delivery. */ }
        });
      };
      connection.db.sessionSnapshot.onInsert(emit);
      connection.db.sessionSnapshot.onDelete(emit);
      connection.db.sessionSnapshot.onUpdate(emit);
      const subscription = connection.subscriptionBuilder()
        .onApplied(() => {
          const currentEpoch = epoch;
          const authorized = firstApplied ? Promise.resolve() : this.call('read', args);
          firstApplied = false;
          void authorized.then(() => {
            if (stopped || epoch !== currentEpoch) return;
            applied = true; clearTimeout(timer); emit();
          }).catch(() => { if (epoch === currentEpoch) fail(); });
        })
        .onError(fail).subscribe('SELECT * FROM session_snapshot');
      cleanup = () => {
        connection.db.sessionSnapshot.removeOnInsert(emit);
        connection.db.sessionSnapshot.removeOnDelete(emit);
        connection.db.sessionSnapshot.removeOnUpdate(emit);
        try { subscription.unsubscribe(); } catch { /* Connection may already be gone. */ }
      };
      if (stopped) cleanup();
    })().catch(fail);
    return stop;
  }
}
