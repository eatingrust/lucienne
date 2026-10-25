import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const phases = new Set(['module-import', 'imports-ready', 'import-failed', 'setup-start', 'setup-ready',
  'setup-failed', 'command-received', 'command-failed', 'dispatch-start', 'capture-start', 'capture-ready',
  'prepare-start', 'document-created', 'layers-ready', 'view-attached', 'prepare-ready', 'wait-start',
  'wait-ready', 'wait-failed', 'apply-start', 'apply-ready', 'response-written', 'response-write-failed']);
const commands = new Set(['hello', 'apply', 'readback', 'observe', 'restore', 'close']);
const errors = new Set(['BridgeError', 'ImportError', 'ModuleNotFoundError', 'PermissionError',
  'FileNotFoundError', 'TypeError', 'ValueError', 'RuntimeError', 'OSError', 'AttributeError',
  'OverflowError', 'Exception']);
interface PluginEvent {
  sequence: number; recordedAtMs: number; phase: string; command: string | null;
  id: string | null; errorClass: string | null;
}
function event(value: unknown): PluginEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1 ||
      !Number.isSafeInteger(v.recordedAtMs) || (v.recordedAtMs as number) < 0 ||
      typeof v.phase !== 'string' || !phases.has(v.phase) ||
      !(v.command === null || (typeof v.command === 'string' && commands.has(v.command))) ||
      !(v.id === null || (typeof v.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.id))) ||
      !(v.errorClass === null || (typeof v.errorClass === 'string' && errors.has(v.errorClass)))) return null;
  // Rebuild fields; never copy arbitrary native JSON, exception messages or paths.
  return { sequence: v.sequence as number, recordedAtMs: v.recordedAtMs as number, phase: v.phase,
    command: v.command as string | null, id: v.id as string | null, errorClass: v.errorClass as string | null };
}
export function sanitizePluginDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const latest = event(v);
  if (v.v !== 1 || v.kind !== 'krita-bridge-status' || !latest || !Array.isArray(v.history) || v.history.length > 24) return null;
  const history = v.history.map(event);
  if (history.some(e => !e)) return null;
  return { v: 1 as const, kind: 'krita-bridge-status' as const, ...latest, history: history as PluginEvent[] };
}
export async function readPluginDiagnostics(file: string) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 32_768 || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0)
      return { state: 'invalid' as const };
    const bytes = Buffer.alloc(32_769);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 32_768) return { state: 'invalid' as const };
    const status = sanitizePluginDiagnostics(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    return status ? { state: 'available' as const, status } : { state: 'invalid' as const };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'unavailable' as const };
  } finally { await handle?.close(); }
}
