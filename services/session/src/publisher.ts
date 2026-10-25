import type { RunEvent } from '../../../contracts/index.js';
import { MAX_BATCH, randomToken } from './capabilities.js';
import { projectEvent, type Delivery } from './projection.js';
import type { MutationPort } from './ports.js';

export type PublisherStatus = 'starting' | 'connected' | 'offline' | 'overflow' | 'unavailable' | 'closed';
const terminalErrors = new Set(['UNAUTHORIZED', 'STALE_STREAM', 'INVALID_EVENT', 'CONFLICT', 'INVALID_ARGUMENT',
  'SEQUENCE_GAP', 'PAIRING_EXPIRED', 'CLOSED', 'TOKEN_PERSISTENCE']);
/** Both transports expose structured codes. Never classify arbitrary provider message text. */
function errorCode(cause: unknown): string | undefined {
  if (!cause || typeof cause !== 'object') return;
  if ('code' in cause && typeof cause.code === 'string') return cause.code;
  if ('data' in cause && cause.data && typeof cause.data === 'object' && 'code' in cause.data &&
    typeof cause.data.code === 'string') return cause.data.code;
}
/** One instance per main-process boot. Attach before the first local selected event. */
export class SessionPublisher {
  readonly streamId = randomToken();
  private queue: Delivery[] = [];
  private next = 0;
  private opened = false;
  private expectedStreamId: string | null | undefined;
  private reconciledGapCursor: number | undefined;
  private busy: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private status: PublisherStatus = 'starting';
  constructor(private port: MutationPort, private producerToken: string,
    private onStatus: (status: PublisherStatus) => void = () => {}) {}
  private report(status: PublisherStatus): void { this.status = status; try { this.onStatus(status); } catch { /* Observer isolation. */ } }
  private terminal(): boolean { return this.status === 'closed' || this.status === 'overflow' || this.status === 'unavailable'; }
  private failed(cause: unknown): void {
    this.stopHeartbeat();
    if (!this.terminal()) this.report(terminalErrors.has(errorCode(cause) ?? '') ? 'unavailable' : 'offline');
  }
  private args(): Record<string, unknown> { return { producerToken: this.producerToken, streamId: this.streamId }; }
  enqueue(input: RunEvent): void {
    if (this.terminal()) return;
    const event = projectEvent(input);
    // Never drop an interior event and silently pretend the replica is complete.
    if (this.queue.length >= 256) { this.report('overflow'); this.stopHeartbeat(); return; }
    this.queue.push({ cursor: ++this.next, event });
    if (this.status !== 'offline') void this.flush();
  }
  flush(): Promise<void> {
    if (this.busy) return this.busy;
    if (this.terminal()) return Promise.resolve();
    this.busy = this.send().finally(() => {
      this.busy = null;
      if (this.queue.length && this.status === 'connected') void this.flush();
    });
    return this.busy;
  }
  private async send(): Promise<void> {
    try {
      // An idle retry has no publish RPC to prove the retained stream is reachable.
      // Keep it offline until the server accepts a heartbeat for that same stream.
      if (this.opened && this.status === 'offline' && this.queue.length === 0) {
        await this.port.call('heartbeat', this.args());
      }
      if (!this.opened) {
        if (this.expectedStreamId === undefined) {
          this.expectedStreamId = (await this.port.call('inspectProducer', { producerToken: this.producerToken })).streamId;
        }
        if (this.terminal()) return;
        await this.port.call('open', { ...this.args(), expectedStreamId: this.expectedStreamId });
        if (this.terminal()) return;
        this.opened = true;
      }
      while (this.queue.length && !this.terminal()) {
        const batch = this.queue.slice(0, MAX_BATCH);
        let result;
        try { result = await this.port.call('publish', { ...this.args(), batch }); }
        catch (cause) {
          if (this.terminal()) return;
          if (errorCode(cause) !== 'SEQUENCE_GAP' || this.reconciledGapCursor === batch[0]!.cursor) throw cause;
          // Heartbeat authenticates this exact stream and returns its current cursor on both backends.
          // ACKed deliveries are no longer retained: never invent missing history or open a replacement stream.
          const current = await this.port.call('heartbeat', this.args());
          if (this.terminal()) return;
          if (!Number.isSafeInteger(current?.cursor) || current.cursor < batch[0]!.cursor - 1 ||
            current.cursor > batch.at(-1)!.cursor) throw cause;
          this.reconciledGapCursor = batch[0]!.cursor;
          // Replay the original deliveries once, including duplicate validation; do not trim by an unverified ACK.
          result = await this.port.call('publish', { ...this.args(), batch });
        }
        if (this.terminal()) return;
        if (!Number.isSafeInteger(result?.cursor) || result.cursor !== batch.at(-1)!.cursor) {
          this.stopHeartbeat(); this.report('unavailable'); return;
        }
        this.queue.splice(0, batch.length);
        this.reconciledGapCursor = undefined;
      }
      if (this.terminal()) return;
      this.report('connected');
      if (this.terminal()) return;
      this.heartbeatTimer ??= setInterval(() => { if (!this.busy) void this.heartbeat(); }, 10_000);
      this.heartbeatTimer.unref?.();
    } catch (cause) { this.failed(cause); }
  }
  private heartbeat(): Promise<void> {
    if (this.busy) return this.busy;
    if (this.terminal()) return Promise.resolve();
    this.busy = this.port.call('heartbeat', this.args()).then(() => undefined).catch(cause => this.failed(cause)).finally(() => {
      this.busy = null;
      if (this.queue.length && this.status === 'connected') void this.flush();
    });
    return this.busy;
  }
  /** Explicit retry uses the same cursor/stream, including after an uncertain HTTP response. */
  resume(): Promise<void> { return this.flush(); }
  async issuePairing(): Promise<{ pairingToken: string; expiresAt: number }> {
    await this.flush();
    if (this.status !== 'connected') throw new Error('SESSION_OFFLINE');
    const pairingToken = randomToken();
    let result;
    try { result = await this.port.call('issuePairing', { ...this.args(), pairingToken }); }
    catch (cause) { this.failed(cause); throw cause; }
    if (this.terminal()) throw new Error('SESSION_OFFLINE');
    return { pairingToken, expiresAt: result.expiresAt };
  }
  async revokeReader(): Promise<void> {
    if (this.terminal()) throw new Error('SESSION_OFFLINE');
    try { await this.port.call('revokeReader', this.args()); }
    catch (cause) { this.failed(cause); throw cause; }
  }
  private stopHeartbeat(): void { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  close(): void { this.report('closed'); this.stopHeartbeat(); this.queue = []; }
  inspect(): { status: PublisherStatus; queued: number } { return { status: this.status, queued: this.queue.length }; }
}
