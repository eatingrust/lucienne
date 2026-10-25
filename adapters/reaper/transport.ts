import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { CommitContext } from '../../contracts/ports.js';
import type { Operation, SourceApp } from '../../contracts/index.js';

export type BridgeCommand = 'hello' | 'apply' | 'readback' | 'observe' | 'restore' | 'close';
export interface ProcessOwner { exited(): boolean; terminate(): Promise<void> }
export function assertCurrent(context: CommitContext): void {
  if (context.signal.aborted || !context.isCurrent()) throw new Error('REAPER_STALE_CONTEXT');
  if (!Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('REAPER_BAD_GENERATION');
}
const field = (value: string | number): string => {
  const result = String(value);
  if (!result || result.length > 160 || /[\x00-\x1f\x7f]/.test(result)) throw new Error('REAPER_BAD_PROTOCOL_FIELD');
  return result;
};
export function atomicText(file: string, value: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
  try { renameSync(temp, file); } finally { try { unlinkSync(temp); } catch {} }
}
export function encodeRequest(input: {
  token: string; sequence: number; command: BridgeCommand; context: CommitContext;
  source: SourceApp; operations?: readonly Operation[];
}): string {
  if (!/^[a-f0-9]{64}$/.test(input.token) || !Number.isSafeInteger(input.sequence) || input.sequence < 1)
    throw new Error('REAPER_BAD_PROTOCOL_IDENTITY');
  const rows = [['protocol', 1], ['token', input.token], ['sequence', input.sequence], ['command', input.command],
    ['runId', input.context.runId], ['requestId', input.context.requestId], ['generation', input.context.generation],
    ['source', input.source], ...(input.operations ?? []).map(op => ['op', op.capabilityId, op.value])];
  const body = rows.map(row => row.map(field).join('\t')).join('\n') + '\n';
  if (Buffer.byteLength(body) > 16_384) throw new Error('REAPER_COMMAND_TOO_LARGE');
  return body;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const code = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
  ? error.message : 'REAPER_BRIDGE_FAILED';

/** One mailbox writer. A rejection waits for a native acknowledgement or process-group exit. */
export class ReaperBridge {
  private sequence = 0;
  private busy = false;
  constructor(private readonly options: {
    directory: string; token: string; process: ProcessOwner; assertAccount: () => void;
    timeoutMs?: number; cancellationDrainMs?: number;
  }) {}
  isQuiescent(): boolean { return !this.busy; }
  async command<T>(command: BridgeCommand, context: CommitContext, source: SourceApp,
    operations?: readonly Operation[]): Promise<T> {
    if (this.busy) throw new Error('REAPER_CONCURRENT_COMMAND');
    assertCurrent(context); this.options.assertAccount();
    const sequence = ++this.sequence;
    const body = encodeRequest({ token: this.options.token, sequence, command, context, source, operations });
    const lease = path.join(this.options.directory, 'lease.tsv');
    const response = path.join(this.options.directory, `response-${sequence}.json`);
    let failure: string | undefined, cancelledAt: number | undefined, acknowledged = false, published = false;
    this.busy = true;
    const revoke = () => { try { unlinkSync(lease); } catch {} };
    const cancel = (reason: string) => { failure ??= reason; cancelledAt ??= Date.now(); revoke(); };
    const renew = () => {
      if (failure) return revoke();
      try {
        assertCurrent(context); this.options.assertAccount();
        atomicText(lease, [['protocol', 1], ['token', this.options.token], ['sequence', sequence],
          ['runId', context.runId], ['requestId', context.requestId], ['generation', context.generation],
          ['expiresAt', Date.now() + 1500]].map(row => row.map(field).join('\t')).join('\n') + '\n');
      } catch (error) { cancel(code(error)); }
    };
    const onAbort = () => cancel('REAPER_STALE_CONTEXT');
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      context.signal.addEventListener('abort', onAbort, { once: true });
      renew(); if (failure) throw new Error(failure);
      atomicText(path.join(this.options.directory, 'request.tsv'), body); published = true;
      heartbeat = setInterval(renew, 100);
      const deadline = Date.now() + (this.options.timeoutMs ?? 20_000);
      while (true) {
        renew();
        try {
          const metadata = await stat(response);
          if (metadata.size > 131_072) throw new Error('REAPER_RESPONSE_TOO_LARGE');
          const reply = JSON.parse(await readFile(response, 'utf8')) as Record<string, unknown>;
          if (reply.protocol === 1 && reply.token === this.options.token && reply.sequence === sequence &&
              reply.runId === context.runId && reply.requestId === context.requestId && reply.generation === context.generation) {
            acknowledged = true;
            if (failure) throw new Error(failure);
            assertCurrent(context); this.options.assertAccount();
            if (reply.ok !== true) throw new Error(typeof reply.error === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(reply.error)
              ? reply.error : 'REAPER_NATIVE_COMMAND_FAILED');
            return reply.result as T;
          }
        } catch (error) {
          if (acknowledged) throw error;
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') cancel(code(error));
        }
        if (this.options.process.exited()) throw new Error(failure ?? 'REAPER_PROCESS_EXITED');
        if (Date.now() >= deadline) cancel('REAPER_COMMAND_TIMEOUT');
        if (cancelledAt !== undefined && Date.now() - cancelledAt >= (this.options.cancellationDrainMs ?? 1000)) {
          await this.stopAndConfirm(); throw new Error(failure ?? 'REAPER_CANCELLED');
        }
        await sleep(25);
      }
    } catch (error) {
      revoke();
      if (published && !acknowledged && !this.options.process.exited()) await this.stopAndConfirm();
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      context.signal.removeEventListener('abort', onAbort); revoke(); this.busy = false;
    }
  }
  private async stopAndConfirm(): Promise<void> {
    try { await this.options.process.terminate(); } catch { /* A failed signal is not an exit receipt. */ }
    while (!this.options.process.exited()) await sleep(50);
  }
}
