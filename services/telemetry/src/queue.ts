import { projectEvent, projectQA, TelemetryError, type TelemetryRecord } from './project.js';

export interface TelemetrySink { write(records: readonly TelemetryRecord[]): Promise<void>; }
export type TelemetryStatus = {
  queued: number; dropped: number; invalid: number; acknowledged: number; failures: number;
  state: 'idle' | 'sending' | 'offline' | 'blocked' | 'closed'; nextAttemptAt: number;
};
/** Caller owns flush scheduling. enqueue never waits for the network or native lifecycle. */
export class TelemetryQueue {
  private records: TelemetryRecord[] = [];
  private pending: Promise<void> | undefined;
  private closed = false;
  private counters: Omit<TelemetryStatus, 'queued'> = {
    dropped: 0, invalid: 0, acknowledged: 0, failures: 0, state: 'idle', nextAttemptAt: 0,
  };
  constructor(private readonly sink: TelemetrySink, private readonly now = () => performance.now(),
    private readonly capacity = 256, private readonly batchSize = 32) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256 ||
      !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new TelemetryError('INVALID_CONFIG');
  }
  event(value: unknown): boolean { return this.enqueue(() => projectEvent(value)); }
  qa(value: unknown): boolean { return this.enqueue(() => projectQA(value)); }
  private enqueue(project: () => TelemetryRecord): boolean {
    if (this.closed) { this.counters.dropped++; return false; }
    try {
      const record = project();
      const previous = this.records.find(r => r.recordKey === record.recordKey);
      if (previous) {
        if (previous.payloadHash !== record.payloadHash) { this.counters.invalid++; return false; }
        return true;
      }
      if (this.records.length >= this.capacity) { this.counters.dropped++; return false; }
      this.records.push(record); return true;
    } catch { this.counters.invalid++; return false; }
  }
  status(): TelemetryStatus { return { ...this.counters, queued: this.records.length }; }
  flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed || !this.records.length || this.counters.state === 'blocked' ||
      this.now() < this.counters.nextAttemptAt) return Promise.resolve();
    const batch = this.records.slice(0, this.batchSize);
    this.counters.state = 'sending';
    this.pending = Promise.resolve().then(() => this.sink.write(batch)).then(() => {
      // clear() can discard a pending batch; remove only the keys actually acknowledged.
      this.records = this.records.filter(r => !batch.includes(r));
      this.counters.acknowledged += batch.length;
      this.counters.failures = 0;
      this.counters.nextAttemptAt = 0;
      if (!this.closed) this.counters.state = 'idle';
    }, (error: unknown) => {
      this.counters.failures++;
      this.counters.nextAttemptAt = this.now() + Math.min(30_000, 250 * 2 ** Math.min(7, this.counters.failures - 1));
      if (!this.closed) this.counters.state = error instanceof TelemetryError && error.code === 'CONFLICT' ? 'blocked' : 'offline';
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /** Drop queued diagnostics explicitly. This does not cancel a write already sent to the server. */
  clear(): void { this.counters.dropped += this.records.length; this.records = []; }
  close(): void { this.closed = true; this.clear(); this.counters.state = 'closed'; }
}
