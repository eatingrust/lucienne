import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { EvidenceDocument, PreparedEvidence, RetrievalQuery } from '../retrieval.js';
import type { QuizInput, nextQuizTurn } from '../quiz.js';
import type { BitdeerExtraction, SourceCapture } from '../providers/bitdeer.js';

export type PreparationWorkerTask =
  | { kind: 'context'; documents: EvidenceDocument[]; query: RetrievalQuery; retrieval: 'moss' }
  | { kind: 'quiz'; input: QuizInput }
  | { kind: 'image'; imageBase64: string; source: SourceCapture };
export type PreparationWorkerResult<T extends PreparationWorkerTask> = T extends { kind: 'context' }
  ? PreparedEvidence : T extends { kind: 'quiz' } ? Awaited<ReturnType<typeof nextQuizTurn>> : BitdeerExtraction;
export interface PreparationWorkerOptions {
  signal: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Trusted local test seam; never populated from HTTP input. */
  workerPath?: string | URL;
}
export type PreparationWorkerErrorCode = 'invalid_worker_options' | 'invalid_worker_task' | 'provider_unavailable'
  | 'worker_failed' | 'worker_protocol_error' | 'worker_response_too_large' | 'worker_timeout' | 'worker_cancelled' | 'worker_cleanup_unknown';
export class PreparationWorkerError extends Error {
  readonly remoteInferenceStopped = null;
  constructor(readonly code: PreparationWorkerErrorCode) { super(code); this.name = 'PreparationWorkerError'; }
}
const MAX_RESPONSE_BYTES = 512 * 1024;
const ENV_KEYS = ['PATH','HOME','TMPDIR','TMP','TEMP','SystemRoot','WINDIR','LANG','LC_ALL',
  'LUCIENNE_MOSS_SDK_PATH','MOSS_PROJECT_ID','MOSS_PROJECT_KEY','ANTHROPIC_API_KEY','ANTHROPIC_WORKSPACE_ID','BITDEER_API_KEY'] as const;
function workerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) if (typeof source[key] === 'string') env[key] = source[key];
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function loaderArgs(): string[] {
  const result: string[] = [];
  const isTsx = (value: string) => value === 'tsx' || value === 'tsx/esm' || /\/tsx\/dist\/(?:loader|esm\/index)\.mjs$/.test(value);
  for (let i = 0; i < process.execArgv.length; i++) {
    const arg = process.execArgv[i]!;
    if (['--import','--loader','--experimental-loader'].includes(arg) && isTsx(process.execArgv[i+1] ?? '')) result.push(arg,process.execArgv[++i]!);
    else if (arg.startsWith('--import=') && isTsx(arg.slice(9))) result.push(arg);
  }
  return result;
}

/** Resolves only after child close; termination does not establish remote metering stopped. */
export async function runPreparationWorker<T extends PreparationWorkerTask>(task: T, options: PreparationWorkerOptions): Promise<PreparationWorkerResult<T>> {
  if (!options?.signal || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function'
      || typeof options.signal.aborted !== 'boolean' || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000) throw new PreparationWorkerError('invalid_worker_options');
  if (options.signal.aborted) throw new PreparationWorkerError('worker_cancelled');
  let request: unknown;
  try {
    request = JSON.parse(JSON.stringify(task));
    if (!object(request) || !['context','quiz','image'].includes(request.kind as string)) throw Error();
  } catch { throw new PreparationWorkerError('invalid_worker_task'); }
  let workerPath: string;
  let execArgv: string[];
  try {
    const target = options.workerPath ?? new URL(import.meta.url.endsWith('.ts') ? './worker-entry.ts' : './worker-entry.js', import.meta.url);
    workerPath = target instanceof URL ? fileURLToPath(target) : target;
    execArgv = loaderArgs();
    if (workerPath.endsWith('.ts') && !execArgv.some(arg => arg.includes('tsx'))) {
      execArgv.push('--import', createRequire(import.meta.url).resolve('tsx/esm'));
    }
  } catch { throw new PreparationWorkerError('worker_failed'); }
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + options.timeoutMs;
    const graceMs = Math.min(1000, Math.floor(options.timeoutMs / 4));
    let child: ReturnType<typeof fork>;
    try {
      child = fork(workerPath, [], { execArgv, env: workerEnvironment(options.env ?? process.env),
        detached: process.platform !== 'win32', serialization: 'json', stdio: ['ignore','ignore','ignore','ipc'] });
    } catch { reject(new PreparationWorkerError('worker_failed')); return; }
    let failure: PreparationWorkerErrorCode | undefined;
    let result: unknown;
    let received = false;
    let closed = false;
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      if (!child.pid) return;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { try { child.kill('SIGKILL'); } catch {} }
    };
    const drainGroup = async (): Promise<boolean> => {
      if (!child.pid || process.platform === 'win32') return true;
      const groupExists = () => {
        try { process.kill(-child.pid!,0); return true; }
        catch (error) { return object(error) && error.code === 'ESRCH' ? false : null; }
      };
      if (groupExists() === false) return true;
      kill();
      const until = performance.now()+500;
      while (performance.now()<until) {
        const exists=groupExists();
        if (exists === false) return true;
        // A probe can transiently return EPERM while the killed group disappears.
        // Retry within the same bound; only ESRCH confirms cleanup, never an error.
        await new Promise(done=>setTimeout(done,10));
      }
      return groupExists() === false;
    };
    const stop = (code: PreparationWorkerErrorCode) => {
      if (closed) return;
      failure ??= code;
      result = undefined;
      kill();
    };
    const cancel = (code: PreparationWorkerErrorCode) => {
      if (closed || failure) return;
      failure = code; result = undefined;
      try { if (child.connected) child.send({ type:'cancel' }, error => { if (error && !closed) kill(); }); } catch { kill(); }
      cancellationTimer = setTimeout(() => { if (!closed) kill(); }, Math.max(0,Math.min(graceMs,deadline-performance.now())));
    };
    const abort = () => cancel('worker_cancelled');
    const timer = setTimeout(() => stop('worker_timeout'), Math.max(0,deadline-performance.now()));
    const cleanupTimer = setTimeout(() => cancel('worker_timeout'), Math.max(0,deadline-performance.now()-graceMs));
    options.signal.addEventListener('abort', abort, { once: true });
    child.on('message', message => {
      if (closed || failure) return;
      if (performance.now() >= deadline) { stop('worker_timeout'); return; }
      try {
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_RESPONSE_BYTES) { stop('worker_response_too_large'); return; }
        if (received || !object(message) || Object.keys(message).length !== 2 || typeof message.ok !== 'boolean') { stop('worker_protocol_error'); return; }
        received = true;
        if (message.ok && Object.hasOwn(message, 'value') && object(message.value)) result = message.value;
        else if (!message.ok && Object.hasOwn(message, 'code')) {
          const code = message.code === 'provider_unavailable' ? 'provider_unavailable'
            : message.code === 'worker_response_too_large' ? 'worker_response_too_large' : 'worker_failed';
          stop(code);
        } else stop('worker_protocol_error');
      } catch { stop('worker_protocol_error'); }
    });
    child.on('error', () => stop('worker_failed'));
    child.once('close', async (code, signal) => {
      closed = true; clearTimeout(timer); clearTimeout(cleanupTimer); clearTimeout(cancellationTimer); options.signal.removeEventListener('abort', abort);
      try { if (!await drainGroup()) failure = 'worker_cleanup_unknown'; }
      catch { failure = 'worker_cleanup_unknown'; }
      if (options.signal.aborted) failure ??= 'worker_cancelled';
      if (performance.now() >= deadline) failure ??= 'worker_timeout';
      if (failure) reject(new PreparationWorkerError(failure));
      else if (code !== 0 || signal || !received || result === undefined) reject(new PreparationWorkerError('worker_failed'));
      else resolve(result as PreparationWorkerResult<T>);
    });
    if (options.signal.aborted) abort();
    else {
      try { child.send(request as object, error => { if (error) stop('worker_failed'); }); }
      catch { stop('worker_failed'); }
    }
  });
}
