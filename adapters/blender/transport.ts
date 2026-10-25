import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { CommitContext } from '../../contracts/ports.js';
import type { Operation } from '../../contracts/index.js';

export type BridgeCommand = 'hello' | 'apply' | 'readback' | 'observe' | 'restore' | 'close';
export interface BridgeProcess {
  exited(): boolean;
  /** Must not resolve until the owned native process and writer group have exited. */
  terminate(): Promise<void>;
}
export function assertCurrent(context: CommitContext): void {
  if (context.signal.aborted || !context.isCurrent()) throw new Error('BLENDER_STALE_CONTEXT');
  if (!Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('BLENDER_BAD_GENERATION');
}
function atomicJSON(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try { renameSync(temp, file); } finally { try { unlinkSync(temp); } catch {} }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const code = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
  ? error.message : 'BLENDER_BRIDGE_FAILED';

/** One outstanding mailbox command; cancellation revokes the native lease synchronously.
 * The promise drains to native acknowledgement or confirmed process exit before settlement. */
export class BlenderBridge {
  private busy = false;
  constructor(private readonly options: {
    directory: string; token: string; process: BridgeProcess;
    assertAccount: () => void; timeoutMs?: number; cancellationDrainMs?: number;
  }) {}
  isQuiescent(): boolean { return !this.busy; }
  async command<T = unknown>(command: BridgeCommand, context: CommitContext, operations?: readonly Operation[]): Promise<T> {
    if (this.busy) throw new Error('BLENDER_CONCURRENT_COMMAND');
    assertCurrent(context); this.options.assertAccount();
    this.busy = true;
    const id = randomUUID(), request = path.join(this.options.directory, 'request.json');
    const response = path.join(this.options.directory, 'response.json'), lease = path.join(this.options.directory, 'lease.json');
    let cancelledAt: number | null = null, failure: string | null = null;
    const revoke = () => { try { unlinkSync(lease); } catch {} };
    const renew = () => {
      if (failure) { revoke(); return; }
      try {
        assertCurrent(context); this.options.assertAccount();
        atomicJSON(lease, { token: this.options.token, runId: context.runId, requestId: context.requestId,
          generation: context.generation, expiresAt: Date.now() + 1500 });
      } catch (error) { failure ??= code(error); cancelledAt ??= Date.now(); revoke(); }
    };
    const abort = () => { failure ??= 'BLENDER_STALE_CONTEXT'; cancelledAt ??= Date.now(); revoke(); };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await unlink(response).catch(error => { if (error.code !== 'ENOENT') throw error; });
      assertCurrent(context); this.options.assertAccount();
      context.signal.addEventListener('abort', abort, { once: true });
      renew();
      if (failure) throw new Error(failure);
      atomicJSON(request, { v: 1, id, token: this.options.token, runId: context.runId, requestId: context.requestId,
        generation: context.generation, command, ...(operations ? { operations } : {}) });
      heartbeat = setInterval(renew, 100);
      const deadline = Date.now() + (this.options.timeoutMs ?? 20_000);
      for (;;) {
        // Guard after every async wait; a failed guard drains instead of returning early.
        if (!failure) renew();
        let raw: string | undefined;
        try { raw = await readFile(response, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { failure ??= 'BLENDER_RESPONSE_READ_FAILED'; cancelledAt ??= Date.now(); revoke(); } }
        if (!failure) renew();
        if (raw) {
          if (raw.length > 2_000_000) { failure ??= 'BLENDER_RESPONSE_TOO_LARGE'; cancelledAt ??= Date.now(); revoke(); }
          else {
            let parsed: { v?: unknown; id?: unknown; ok?: unknown; result?: T; error?: unknown } | undefined;
            try { parsed = JSON.parse(raw); } catch { /* Atomic writer never exposes a partial response. */ }
            if (parsed?.v === 1 && parsed.id === id) {
              if (failure) throw new Error(failure);
              assertCurrent(context); this.options.assertAccount();
              if (parsed.ok !== true) throw new Error(typeof parsed.error === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.error)
                ? parsed.error : 'BLENDER_NATIVE_COMMAND_FAILED');
              return parsed.result as T;
            }
          }
        }
        if (this.options.process.exited()) throw new Error(failure ?? 'BLENDER_PROCESS_EXITED');
        if (Date.now() >= deadline) { failure ??= 'BLENDER_COMMAND_TIMEOUT'; cancelledAt ??= Date.now(); revoke(); }
        if (cancelledAt !== null && Date.now() - cancelledAt >= (this.options.cancellationDrainMs ?? 2000)) {
          await this.stopAndConfirm();
          throw new Error(failure ?? 'BLENDER_CANCELLED');
        }
        await sleep(25);
      }
    } catch (error) {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
      failure ??= code(error);
      // A write/read/parse failure after publishing a command also needs quiescence.
      revoke();
      if (!this.options.process.exited() && !(await this.hasAcknowledgement(response, id)))
        await this.stopAndConfirm();
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      context.signal.removeEventListener('abort', abort);
      revoke(); this.busy = false;
    }
  }
  private async stopAndConfirm(): Promise<void> {
    // Failure to signal is never a native completion receipt. Keep the lane held
    // until the process owner can independently report the writer group gone.
    try { await this.options.process.terminate(); } catch { /* Still drain below. */ }
    while (!this.options.process.exited()) await sleep(50);
  }
  private async hasAcknowledgement(file: string, id: string): Promise<boolean> {
    try { const result = JSON.parse(await readFile(file, 'utf8')); return result.v === 1 && result.id === id; }
    catch { return false; }
  }
}
