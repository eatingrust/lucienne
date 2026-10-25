import { spawn } from 'node:child_process';
import { statSync, lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import type { CommitContext } from '../../contracts/ports.js';
import { assertCurrent } from './transport.js';

export interface BlenderWindow {
  x: number; y: number; width: number; height: number; layer: number; alpha: number; onScreen: boolean;
}
export interface BlenderWindowObservation {
  pid: number; bundleId: string; active: boolean; hidden: boolean; visible: boolean;
  windowCount: number; windows: BlenderWindow[];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function parseObservation(value: unknown): BlenderWindowObservation | undefined {
  if (!record(value) || !Number.isSafeInteger(value.pid) || !finite(value.pid, 1, 2_147_483_647) ||
      typeof value.bundleId !== 'string' || value.bundleId.length > 160 ||
      typeof value.active !== 'boolean' || typeof value.hidden !== 'boolean' || typeof value.visible !== 'boolean' ||
      !Array.isArray(value.windows) || value.windows.length > 64 || value.windowCount !== value.windows.length) return undefined;
  const windows: BlenderWindow[] = [];
  for (const row of value.windows) {
    if (!record(row) || !finite(row.x, -100_000, 100_000) || !finite(row.y, -100_000, 100_000) ||
        !finite(row.width, 0, 100_000) || !finite(row.height, 0, 100_000) ||
        !Number.isSafeInteger(row.layer) || !finite(row.layer, -100_000, 100_000) ||
        !finite(row.alpha, 0, 1) || typeof row.onScreen !== 'boolean') return undefined;
    windows.push({ x: row.x, y: row.y, width: row.width, height: row.height,
      layer: row.layer, alpha: row.alpha, onScreen: row.onScreen });
  }
  return { pid: value.pid, bundleId: value.bundleId, active: value.active, hidden: value.hidden,
    visible: value.visible, windowCount: windows.length, windows };
}

/** Actual OS visibility is required separately from bpy responsiveness or a live process. */
export function validateWindowObservation(payload: unknown, expectedPid: number): boolean {
  const value = parseObservation(payload);
  return Number.isSafeInteger(expectedPid) && expectedPid > 0 && !!value && value.pid === expectedPid &&
    value.bundleId === 'org.blenderfoundation.blender' && value.active && !value.hidden && value.visible &&
    value.windows.some(window => window.layer === 0 && window.alpha > 0 && window.onScreen &&
      window.width >= 320 && window.height >= 240);
}
function assertProbeAccount(): void {
  const account = userInfo();
  if (process.platform !== 'darwin' || account.username !== 'lucienne' || account.homedir !== '/PUBLIC_NATIVE_HOME_REQUIRED' ||
      process.getuid?.() !== account.uid || process.geteuid?.() !== account.uid || statSync('/dev/console').uid !== account.uid)
    throw new Error('BLENDER_WINDOW_DEMO_ACCOUNT_REQUIRED');
}
function assertExecutable(filename: string): void {
  if (!path.isAbsolute(filename) || filename.includes('\0') || path.resolve(filename) !== filename)
    throw new Error('BLENDER_WINDOW_ABSOLUTE_PATH_REQUIRED');
  let cursor = path.parse(filename).root;
  for (const component of filename.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, component);
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('BLENDER_WINDOW_SYMLINK_REJECTED');
  }
  if (!lstatSync(filename).isFile()) throw new Error('BLENDER_WINDOW_EXECUTABLE_REQUIRED');
}

/** This helper is allowed to mutate focus, so every failure drains to actual child close. */
async function runHelper(executablePath: string, args: string[], context: CommitContext): Promise<string> {
  assertCurrent(context); assertProbeAccount();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executablePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/PUBLIC_NATIVE_HOME_REQUIRED', USER: 'lucienne', LOGNAME: 'lucienne' },
    });
    let failure: Error | undefined, output = '', bytes = 0;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const failAndDrain = (error: Error) => {
      failure ??= error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGTERM'); } catch { /* Wait for close; never infer settlement from kill acknowledgement. */ }
      if (!forceKill) forceKill = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 250);
    };
    const abort = () => failAndDrain(new Error('BLENDER_STALE_CONTEXT'));
    const timeout = setTimeout(() => failAndDrain(new Error('BLENDER_WINDOW_PROBE_TIMEOUT')), 3000);
    const poll = setInterval(() => {
      try { assertCurrent(context); assertProbeAccount(); }
      catch (error) { failAndDrain(error instanceof Error ? error : new Error('BLENDER_WINDOW_CONTEXT_CHANGED')); }
    }, 25);
    context.signal.addEventListener('abort', abort, { once: true });
    try { assertCurrent(context); assertProbeAccount(); }
    catch (error) { failAndDrain(error instanceof Error ? error : new Error('BLENDER_WINDOW_CONTEXT_CHANGED')); }
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32_768) { failAndDrain(new Error('BLENDER_WINDOW_OUTPUT_TOO_LARGE')); return; }
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32_768) failAndDrain(new Error('BLENDER_WINDOW_OUTPUT_TOO_LARGE'));
    });
    child.once('error', () => { failure ??= new Error('BLENDER_WINDOW_PROBE_FAILED'); });
    child.once('close', (code) => {
      clearTimeout(timeout); clearInterval(poll);
      if (forceKill) clearTimeout(forceKill);
      context.signal.removeEventListener('abort', abort);
      try { assertCurrent(context); assertProbeAccount(); }
      catch (error) { failure ??= error instanceof Error ? error : new Error('BLENDER_WINDOW_CONTEXT_CHANGED'); }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('BLENDER_WINDOW_PROBE_FAILED'));
      else resolve(output);
    });
  });
}
async function probe(executablePath: string, pid: number, context: CommitContext, activate: boolean): Promise<BlenderWindowObservation> {
  assertCurrent(context); assertProbeAccount();
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) throw new Error('BLENDER_WINDOW_INVALID_PID');
  assertExecutable(executablePath);
  assertCurrent(context); assertProbeAccount();
  const stdout = await runHelper(executablePath, activate ? ['--activate', String(pid)] : [String(pid)], context);
  assertCurrent(context); assertProbeAccount();
  let decoded: unknown;
  try { decoded = JSON.parse(stdout); } catch { throw new Error('BLENDER_WINDOW_INVALID_RESPONSE'); }
  const result = parseObservation(decoded);
  if (!result || result.pid !== pid || result.bundleId !== 'org.blenderfoundation.blender')
    throw new Error('BLENDER_WINDOW_INVALID_RESPONSE');
  result.visible = validateWindowObservation(result, pid);
  assertCurrent(context); assertProbeAccount();
  return result;
}
/** Read-only observation; never raises, unhides or activates Blender. */
export function observeBlenderWindow(executablePath: string, pid: number, context: CommitContext): Promise<BlenderWindowObservation> {
  return probe(executablePath, pid, context, false);
}
/** Explicit apply-time focus request. The returned observation may still be inactive; callers must reobserve. */
export function activateBlenderWindow(executablePath: string, pid: number, context: CommitContext): Promise<BlenderWindowObservation> {
  return probe(executablePath, pid, context, true);
}
