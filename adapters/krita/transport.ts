import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { CommitContext } from '../../contracts/ports.js';
import type { Operation } from '../../contracts/index.js';

export type BridgeCommand = 'hello' | 'apply' | 'readback' | 'observe' | 'restore' | 'close';
export const KRITA_COMMAND_TIMEOUT_MS = 20_000;
export const KRITA_STARTUP_TIMEOUT_MS = 120_000;
export interface BridgeDiagnostic {
  command: BridgeCommand;
  /** Host-generated command UUID; never a visitor run/request identifier. */
  id: string;
  state: 'started' | 'published' | 'acknowledged' | 'deadline' | 'revoked' | 'process-exited' | 'settled';
  code: string | null;
  elapsedMs: number;
}
// Diagnostics never retain exception bodies, native results, operation values, or
// caller identifiers. Unknown errors receive one fixed redacted classification.
const diagnosticCodes = new Set([
  'OK', 'KRITA_COMMAND_TIMEOUT', 'KRITA_STALE_CONTEXT', 'KRITA_PROCESS_EXITED',
  'KRITA_RESPONSE_READ_FAILED', 'KRITA_RESPONSE_TOO_LARGE', 'KRITA_BRIDGE_FAILED',
  'KRITA_NATIVE_COMMAND_FAILED', 'KRITA_DEMO_PROCESS_REQUIRED', 'KRITA_DEMO_CONSOLE_REQUIRED',
  'KRITA_MACOS_REQUIRED', 'KRITA_BAD_GENERATION', 'WINDOW_NOT_READY',
  'EXISTING_DOCUMENTS', 'EXISTING_WINDOWS', 'UNOWNED_DOCUMENTS_PRESENT',
  'DOCUMENTS_STILL_OPEN', 'NATIVE_EXCEPTION', 'HELLO_REQUIRED', 'EXPIRED_LEASE',
  'STALE_LEASE', 'WRONG_ACCOUNT', 'WRONG_CONSOLE_OWNER', 'MISSING_NATIVE_ACTION',
  'MISSING_NATIVE_DOCK', 'WORK_AREA_NOT_DISTINCT', 'CANVAS_NOT_READY',
  'NATIVE_SHORTCUT_DRIFT', 'NATIVE_SHORTCUT_CONFLICT', 'NATIVE_PANEL_DRIFT',
  'NATIVE_WORK_AREA_DRIFT', 'NATIVE_TOOLS_DRIFT', 'DOCUMENT_CREATE_FAILED',
  'OWNED_DOCUMENT_NOT_ACTIVE', 'DOCUMENT_CLOSE_FAILED', 'UNCOMMITTED_REQUEST',
]);
export const diagnosticCode = (value: string): string => diagnosticCodes.has(value) ? value : 'KRITA_BRIDGE_FAILED';
export interface BridgeProcess {
  exited(): boolean;
  /** Must not resolve until the owned native process and writer group have exited. */
  terminate(): Promise<void>;
}
export function assertCurrent(context: CommitContext): void {
  if (context.signal.aborted || !context.isCurrent()) throw new Error('KRITA_STALE_CONTEXT');
  if (!Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('KRITA_BAD_GENERATION');
}
function atomicJSON(file: string, value: unknown): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try { renameSync(temp, file); } finally { try { unlinkSync(temp); } catch {} }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const code = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
  ? error.message : 'KRITA_BRIDGE_FAILED';

/** One outstanding mailbox command; cancellation revokes the native lease synchronously.
 * The promise drains to native acknowledgement or confirmed process exit before settlement. */
export class KritaBridge {
  private busy = false;
  private diagnostics: BridgeDiagnostic[] = [];
  getDiagnostics(): BridgeDiagnostic[] { return structuredClone(this.diagnostics); }
  constructor(private readonly options: {
    directory: string; token: string; process: BridgeProcess;
    assertAccount: () => void; timeoutMs?: number; cancellationDrainMs?: number;
    /** One absolute performance.now() deadline, shared by every startup hello. */
    startupDeadline?: number;
  }) {
    if (options.startupDeadline !== undefined && !Number.isFinite(options.startupDeadline))
      throw new Error('KRITA_BAD_STARTUP_DEADLINE');
  }
  isQuiescent(): boolean { return !this.busy; }
  async command<T = unknown>(command: BridgeCommand, context: CommitContext, operations?: readonly Operation[]): Promise<T> {
    if (this.busy) throw new Error('KRITA_CONCURRENT_COMMAND');
    assertCurrent(context); this.options.assertAccount();
    this.busy = true;
    const id = randomUUID(), request = path.join(this.options.directory, 'request.json');
    const response = path.join(this.options.directory, 'response.json'), lease = path.join(this.options.directory, 'lease.json');
    let cancelledAt: number | null = null, failure: string | null = null;
    const started = performance.now();
    const deadline = command === 'hello' && this.options.startupDeadline !== undefined
      ? this.options.startupDeadline : started + (this.options.timeoutMs ?? KRITA_COMMAND_TIMEOUT_MS);
    let outcome: string | null = null, leaseWritten = false, revocationRecorded = false, exitRecorded = false;
    const diagnostic = (state: BridgeDiagnostic['state'], value: string | null = null) => {
      this.diagnostics.push({ command, id, state, code: value === null ? null : diagnosticCode(value),
        elapsedMs: Math.max(0, Math.round(performance.now() - started)) });
      if (this.diagnostics.length > 16) this.diagnostics.splice(0, this.diagnostics.length - 16);
    };
    diagnostic('started');
    const exited = () => { if (!exitRecorded) { diagnostic('process-exited'); exitRecorded = true; } };
    const revoke = () => {
      try { unlinkSync(lease); } catch {}
      if (leaseWritten && !revocationRecorded) { diagnostic('revoked', failure); revocationRecorded = true; }
    };
    const expire = () => {
      if (!failure && performance.now() >= deadline) {
        diagnostic('deadline', 'KRITA_COMMAND_TIMEOUT');
        failure = 'KRITA_COMMAND_TIMEOUT'; cancelledAt ??= Date.now(); revoke();
      }
    };
    const renew = () => {
      expire();
      if (failure) { revoke(); return; }
      try {
        assertCurrent(context); this.options.assertAccount();
        expire(); if (failure) return;
        atomicJSON(lease, { token: this.options.token, runId: context.runId, requestId: context.requestId,
          generation: context.generation, expiresAt: Date.now() + 1500 });
        leaseWritten = true;
      } catch (error) { failure ??= code(error); cancelledAt ??= Date.now(); revoke(); }
    };
    const abort = () => { failure ??= 'KRITA_STALE_CONTEXT'; cancelledAt ??= Date.now(); revoke(); };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await unlink(response).catch(error => { if (error.code !== 'ENOENT') throw error; });
      assertCurrent(context); this.options.assertAccount();
      context.signal.addEventListener('abort', abort, { once: true });
      renew();
      expire();
      if (failure) throw new Error(failure);
      atomicJSON(request, { v: 1, id, token: this.options.token, runId: context.runId, requestId: context.requestId,
        generation: context.generation, command, ...(operations ? { operations } : {}) });
      diagnostic('published');
      heartbeat = setInterval(renew, 100);
      for (;;) {
        // Guard after every async wait; a failed guard drains instead of returning early.
        if (!failure) renew();
        let raw: string | undefined;
        try { raw = await readFile(response, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { failure ??= 'KRITA_RESPONSE_READ_FAILED'; cancelledAt ??= Date.now(); revoke(); } }
        if (!failure) renew();
        if (raw) {
          if (raw.length > 2_000_000) { failure ??= 'KRITA_RESPONSE_TOO_LARGE'; cancelledAt ??= Date.now(); revoke(); }
          else {
            let parsed: { v?: unknown; id?: unknown; ok?: unknown; result?: T; error?: unknown } | undefined;
            try { parsed = JSON.parse(raw); } catch { /* Atomic writer never exposes a partial response. */ }
            if (parsed?.v === 1 && parsed.id === id) {
              diagnostic('acknowledged', parsed.ok === true ? 'OK' : typeof parsed.error === 'string' ? parsed.error : 'KRITA_NATIVE_COMMAND_FAILED');
              expire();
              if (failure) throw new Error(failure);
              assertCurrent(context); this.options.assertAccount();
              expire(); if (failure) throw new Error(failure);
              if (parsed.ok !== true) throw new Error(typeof parsed.error === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(parsed.error)
                ? parsed.error : 'KRITA_NATIVE_COMMAND_FAILED');
              outcome = 'OK';
              return parsed.result as T;
            }
          }
        }
        if (this.options.process.exited()) { exited(); throw new Error(failure ?? 'KRITA_PROCESS_EXITED'); }
        expire();
        if (cancelledAt !== null && Date.now() - cancelledAt >= (this.options.cancellationDrainMs ?? 2000)) {
          await this.stopAndConfirm(); exited();
          throw new Error(failure ?? 'KRITA_CANCELLED');
        }
        await sleep(25);
      }
    } catch (error) {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = undefined; }
      failure ??= code(error); outcome = code(error);
      // A write/read/parse failure after publishing a command also needs quiescence.
      revoke();
      const processExited = this.options.process.exited();
      if (!processExited && !(await this.hasAcknowledgement(response, id))) {
        await this.stopAndConfirm(); exited();
      } else if (processExited) exited();
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      context.signal.removeEventListener('abort', abort);
      revoke(); this.busy = false;
      diagnostic('settled', outcome ?? failure ?? 'KRITA_BRIDGE_FAILED');
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
