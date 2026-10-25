import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { statSync, unlinkSync } from 'node:fs';
import { access, mkdir, cp, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommitContext, NativeReadback, NativeResetResult } from '../../contracts/ports.js';
import type { Operation } from '../../contracts/index.js';
import { catalogForSource, type ReaperSource } from './catalog.js';
import { ReaperBaseline, assertReaperPath, type ReaperBaselineInspection, type ReaperBaselineSnapshot } from './baseline.js';
import { ReaperBridge, assertCurrent, atomicText, type BridgeCommand } from './transport.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const DEFAULT_REAPER_APP = '/PUBLIC_NATIVE_APPS_REQUIRED/REAPER.app';
export interface ReaperRuntimeOptions {
  source: ReaperSource; probeExecutable: string; appPath?: string; sessionRoot?: string; nativeDirectory?: string;
}
export interface NativeHello { nativeVersion: string; resourcePath: string; iniPath: string; account: string; bridgeReady: boolean }
/** Fresh observation of the finite adapter-owned settings only. This is not a
 * recents, visitor-state, late-write or ordinary-relaunch acceptance receipt. */
export interface ReaperResetInspection {
  scope: 'adapter-settings-only';
  baselineCompared: boolean;
  targetClosed: boolean;
  sessionAbsent: boolean;
  baseline: ReaperBaselineInspection;
  expectedBaseline: ReaperBaselineSnapshot;
}
export interface ReaperRuntimePort {
  start(context: CommitContext): Promise<NativeHello>;
  command<T>(command: BridgeCommand, context: CommitContext, operations?: readonly Operation[]): Promise<T>;
  readback(context: CommitContext): Promise<NativeReadback>;
  reset(context: CommitContext): Promise<NativeResetResult>;
  revokeActions(): void;
  inspectReset?(): Promise<ReaperResetInspection>;
}
export function assertDemoAccount(): void {
  const user = userInfo();
  if (process.platform !== 'darwin') throw new Error('REAPER_MACOS_REQUIRED');
  if (user.username !== 'lucienne' || user.homedir !== '/PUBLIC_NATIVE_HOME_REQUIRED' || process.geteuid?.() !== user.uid)
    throw new Error('REAPER_DEMO_PROCESS_REQUIRED');
  if (statSync('/dev/console').uid !== user.uid) throw new Error('REAPER_DEMO_CONSOLE_REQUIRED');
}
export function reaperChildEnvironment(sessionRoot: string, token: string, runId: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/PUBLIC_NATIVE_HOME_REQUIRED', USER: 'lucienne', LOGNAME: 'lucienne',
    LANG: 'en_US.UTF-8', TMPDIR: `${path.join(sessionRoot, 'tmp')}/`,
    LUCIENNE_REAPER_DIR: sessionRoot, LUCIENNE_REAPER_TOKEN: token, LUCIENNE_REAPER_RUN: runId };
}
export function actionId(action: string): string {
  return 'RS' + createHash('sha1').update(`lucienne-reaper-v1:${action}`).digest('hex');
}
/** REAPER's native keymap parser loads these before ReaScript starts. Actual bindings are read back by the bridge. */
export function stageKeymap(original: string, source: ReaperSource, nativeDirectory: string): string {
  if (!path.isAbsolute(nativeDirectory) || /[\x00-\x1f\x7f"\\]/.test(nativeDirectory)) throw new Error('REAPER_BAD_SCRIPT_PATH');
  const bindings = catalogForSource(source).filter(cap => cap.bindingAction).map(cap => ({
    action: cap.bindingAction!, key: cap.values[0]!, code: cap.values[0] === 'Space' ? 32 : cap.values[0]!.charCodeAt(0),
  }));
  const codes = new Set(bindings.map(binding => binding.code));
  const rows = original.split(/\r?\n/).filter(line => {
    const match = /^KEY\s+(\d+)\s+(\d+)\s+\S+\s+(\d+)(?:\s|$)/.exec(line);
    return !(match && Number(match[1]) === 1 && codes.has(Number(match[2])) && Number(match[3]) === 0);
  });
  for (const binding of bindings) {
    rows.push(`SCR 4 0 ${actionId(binding.action)} "Custom: Lucienne ${binding.action}" "${path.join(nativeDirectory, binding.action + '.lua')}"`);
    rows.push(`KEY 1 ${binding.code} _${actionId(binding.action)} 0`);
  }
  // Resolve's prepared source profile has no select key. Keep return-to-selection
  // available in REAPER's native Actions list without inventing a source binding.
  if (!bindings.some(binding => binding.action === 'select'))
    rows.push(`SCR 4 0 ${actionId('select')} "Custom: Lucienne select" "${path.join(nativeDirectory, 'select.lua')}"`);
  return rows.join('\n').replace(/\n+$/, '') + '\n';
}
/** Small generated, owned audio task fixture; it is not a claimed live translation result. */
export function makeAudioFixture(): Buffer {
  const rate = 22050, samples = rate * 8, out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate, envelope = Math.min(1, t * 20, (8 - t) * 20) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 1.5 * t) ** 2);
    out.writeInt16LE(Math.round(1800 * envelope * Math.sin(2 * Math.PI * (220 + 55 * Math.floor(t / 2)) * t)), 44 + i * 2);
  }
  return out;
}
async function noExistingReaper(): Promise<void> {
  try { const { stdout } = await exec('/usr/bin/pgrep', ['-x', 'REAPER']); if (stdout.trim()) throw new Error('REAPER_ALREADY_RUNNING'); }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

export class ReaperRuntime implements ReaperRuntimePort {
  readonly sessionRoot: string;
  readonly resourceDirectory = '/PUBLIC_NATIVE_HOME_REQUIRED/Library/Application Support/REAPER';
  private readonly appPath: string;
  private readonly nativeDirectory: string;
  private child?: ChildProcess;
  private exitPromise?: Promise<void>;
  private closed = true;
  private bridge?: ReaperBridge;
  private baseline?: ReaperBaseline;
  private completedBaseline?: ReaperBaseline;
  private hello?: NativeHello;
  private started = false;
  private created = false;
  private touched = false;
  private unowned = false;
  private stopPromise?: Promise<void>;
  private token?: string;
  constructor(private readonly options: ReaperRuntimeOptions) {
    const appPath = options.appPath ?? DEFAULT_REAPER_APP;
    const sessionRoot = options.sessionRoot ?? '/PUBLIC_NATIVE_HOME_REQUIRED/Library/Application Support/Lucienne/reaper-session';
    const nativeDirectory = options.nativeDirectory ?? fileURLToPath(new URL('./native/', import.meta.url));
    for (const item of [appPath, sessionRoot, nativeDirectory, options.probeExecutable])
      if (!path.isAbsolute(item) || /[\x00-\x1f\x7f]/.test(item)) throw new Error('REAPER_ABSOLUTE_PATH_REQUIRED');
    this.appPath = path.resolve(appPath); this.sessionRoot = path.resolve(sessionRoot); this.nativeDirectory = path.resolve(nativeDirectory);
  }
  async preflight(): Promise<void> {
    assertDemoAccount();
    if (!this.sessionRoot.startsWith('/PUBLIC_NATIVE_HOME_REQUIRED/Library/Application Support/Lucienne/')) throw new Error('REAPER_SESSION_OUTSIDE_DEMO_ROOT');
    for (const file of [this.appPath, this.sessionRoot, this.nativeDirectory, this.resourceDirectory, this.options.probeExecutable]) await assertReaperPath(file);
    await access(path.join(this.appPath, 'Contents/MacOS/REAPER'), constants.X_OK);
    await access(path.join(this.nativeDirectory, 'bridge.lua'), constants.R_OK);
    await access(this.options.probeExecutable, constants.X_OK);
    await noExistingReaper(); assertDemoAccount();
    try { await lstat(this.sessionRoot); throw new Error('REAPER_RECOVERY_REQUIRED'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  async start(context: CommitContext): Promise<NativeHello> {
    assertCurrent(context); assertDemoAccount();
    if (this.hello) return structuredClone(this.hello);
    if (this.started) throw new Error('REAPER_RESET_REQUIRED');
    await this.preflight(); assertCurrent(context); assertDemoAccount(); this.started = true;
    await mkdir(path.dirname(this.sessionRoot), { recursive: true, mode: 0o700 });
    assertCurrent(context); assertDemoAccount(); await assertReaperPath(this.sessionRoot);
    await mkdir(this.sessionRoot, { mode: 0o700 }); this.created = true;
    this.baseline = await ReaperBaseline.capture({ resourceDirectory: this.resourceDirectory, backupDirectory: path.join(this.sessionRoot, 'baseline') });
    assertCurrent(context); assertDemoAccount();
    const native = path.join(this.sessionRoot, 'native');
    await mkdir(native, { mode: 0o700 }); await mkdir(path.join(this.sessionRoot, 'tmp'), { mode: 0o700 });
    // Source scripts are the reviewed native surface. No arbitrary planner text is executable.
    for (const name of ['bridge.lua', 'bridge_core.lua', 'protocol.lua', 'actions.lua']) {
      assertCurrent(context); await cp(path.join(this.nativeDirectory, name), path.join(native, name));
    }
    for (const action of ['select', 'razor-tool', 'blade-tool', 'pan', 'play-pause', 'preview-toggle', 'mark-in']) {
      assertCurrent(context);
      await writeFile(path.join(native, action + '.lua'),
        `local dir = os.getenv('LUCIENNE_REAPER_DIR')\nif dir then dofile(dir .. '/native/actions.lua').run('${action}') end\n`,
        { mode: 0o600, flag: 'wx' });
    }
    await writeFile(path.join(this.sessionRoot, 'fixture.wav'), makeAudioFixture(), { mode: 0o600, flag: 'wx' });
    const kbPath = path.join(this.resourceDirectory, 'reaper-kb.ini');
    const original = await readFile(kbPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    await mkdir(this.resourceDirectory, { recursive: true, mode: 0o700 });
    await assertReaperPath(kbPath); assertCurrent(context); assertDemoAccount();
    this.touched = true; atomicText(kbPath, stageKeymap(original, this.options.source, native));
    this.token = randomBytes(32).toString('hex');
    assertCurrent(context); assertDemoAccount();
    await noExistingReaper(); assertCurrent(context); assertDemoAccount();
    atomicText(path.join(this.sessionRoot, 'active.tsv'), `protocol\t1\ntoken\t${this.token}\nrunId\t${context.runId}\n`);
    this.closed = false;
    const child = spawn(path.join(this.appPath, 'Contents/MacOS/REAPER'), ['-new', path.join(native, 'bridge.lua')], {
      cwd: this.sessionRoot, env: reaperChildEnvironment(this.sessionRoot, this.token, context.runId), stdio: 'ignore', detached: true,
    });
    this.child = child;
    this.exitPromise = new Promise(resolve => {
      child.once('error', () => { this.closed = true; resolve(); });
      child.once('close', () => { this.closed = true; resolve(); });
    });
    this.bridge = new ReaperBridge({ directory: this.sessionRoot, token: this.token, assertAccount: assertDemoAccount,
      process: { exited: () => this.closed && (!child.pid || !groupAlive(child.pid)), terminate: () => this.terminate() } });
    const hello = await this.command<NativeHello>('hello', context);
    assertCurrent(context); assertDemoAccount();
    if (!hello.bridgeReady || !/^7\.83(?:[./\s-]|$)/.test(hello.nativeVersion) || hello.account !== 'lucienne' ||
        hello.resourcePath !== this.resourceDirectory || hello.iniPath !== path.join(this.resourceDirectory, 'reaper.ini'))
      throw new Error('REAPER_NATIVE_HANDSHAKE_INVALID');
    this.hello = hello;
    return structuredClone(hello);
  }
  async command<T>(command: BridgeCommand, context: CommitContext, operations?: readonly Operation[]): Promise<T> {
    if (!this.bridge || this.closed) throw new Error('REAPER_NOT_RUNNING');
    try {
      const result = await this.bridge.command<T>(command, context, this.options.source, operations);
      if (command !== 'observe') return result;
      assertCurrent(context);
      const pid = this.child?.pid;
      if (!pid || this.closed || !this.child?.spawnfile) throw new Error('REAPER_PROCESS_EXITED');
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('REAPER_BAD_OBSERVATION');
      // Override any wire claim with the process this runtime actually owns.
      return { ...result, nativeProcess: { pid, executable: this.child.spawnfile } } as T;
    }
    catch (error) {
      if (error instanceof Error && /UNOWNED|EXISTING_PROJECT|SAVED_PROJECT|PROJECT_(?:CONTEXT_)?CHANGED|PROJECT_IDENTITY_UNAVAILABLE|PROJECT_ITEM_ENUMERATION_FAILED/.test(error.message)) this.unowned = true;
      throw error;
    }
  }
  async readback(context: CommitContext): Promise<NativeReadback> {
    const native = await this.command<{ requestId: string; operations: Operation[]; bridgeReady: boolean; ownedProjectReady: boolean }>('readback', context);
    assertCurrent(context); assertDemoAccount();
    const pid = this.child?.pid;
    if (!pid || this.closed) throw new Error('REAPER_PROCESS_EXITED');
    const { stdout } = await exec(this.options.probeExecutable, [String(pid)], { timeout: 5000, maxBuffer: 32_768 });
    assertCurrent(context); assertDemoAccount();
    const probe = JSON.parse(stdout) as { protocol: number; pid: number; targetVisible: boolean; interactive: boolean };
    if (probe.protocol !== 1 || probe.pid !== pid || typeof probe.targetVisible !== 'boolean' || typeof probe.interactive !== 'boolean')
      throw new Error('REAPER_BAD_READINESS_PROBE');
    return { requestId: native.requestId, operations: native.operations, targetVisible: probe.targetVisible,
      interactive: probe.interactive && native.bridgeReady === true && native.ownedProjectReady === true, evidenceRefs: [] };
  }
  revokeActions(): void { if (this.created) try { unlinkSync(path.join(this.sessionRoot, 'active.tsv')); } catch {} }
  async terminate(): Promise<void> {
    this.revokeActions();
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwned();
    try { await this.stopPromise; } finally { this.stopPromise = undefined; }
  }
  private async stopOwned(): Promise<void> {
    const pid = this.child?.pid;
    if (!pid) { await this.exitPromise; return; }
    const signal = (value: NodeJS.Signals) => {
      try { if (groupAlive(pid)) process.kill(-pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    signal('SIGTERM');
    const force = setTimeout(() => { try { signal('SIGKILL'); } catch {} }, 1500);
    try { await this.exitPromise; while (groupAlive(pid)) { signal('SIGKILL'); await delay(25); } }
    finally { clearTimeout(force); }
  }
  async reset(context: CommitContext): Promise<NativeResetResult> {
    assertDemoAccount(); this.revokeActions();
    if (this.unowned && !this.closed) throw new Error('REAPER_UNOWNED_STATE_REQUIRES_OPERATOR');
    if (this.bridge && !this.closed) {
      try { await this.command('restore', context); await this.command('close', context); }
      catch (error) { if (this.unowned) throw new Error('REAPER_UNOWNED_STATE_REQUIRES_OPERATOR'); }
    }
    await this.terminate(); assertDemoAccount();
    await noExistingReaper(); assertDemoAccount();
    if (!this.closed || (this.bridge && !this.bridge.isQuiescent())) throw new Error('REAPER_NOT_QUIESCENT');
    if (this.touched && !this.baseline) throw new Error('REAPER_BASELINE_UNAVAILABLE');
    if (this.baseline) {
      const restored = await this.baseline.restore(); assertDemoAccount();
      if (!restored.preferencesRestored || !await this.baseline.verify()) throw new Error('REAPER_BASELINE_RESTORE_FAILED');
    }
    // Keep the recovery backup through every verification that can fail.
    await noExistingReaper(); assertDemoAccount();
    if (this.baseline && !await this.baseline.verify()) throw new Error('REAPER_BASELINE_CHANGED_AFTER_RESET');
    if (this.created) { await assertReaperPath(this.sessionRoot); await rm(this.sessionRoot, { recursive: true }); }
    this.completedBaseline = this.baseline ?? this.completedBaseline;
    this.child = undefined; this.bridge = undefined; this.baseline = undefined; this.hello = undefined;
    this.created = false; this.started = false; this.touched = false; this.token = undefined; this.unowned = false;
    return { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true, evidenceRefs: [] };
  }
  private async assertResetInspectionSafe(): Promise<void> {
    assertDemoAccount(); await noExistingReaper(); assertDemoAccount();
  }
  async inspectReset(): Promise<ReaperResetInspection> {
    await this.assertResetInspectionSafe();
    const completed = this.completedBaseline;
    if (!completed) throw new Error('REAPER_RESET_NOT_COMPLETED');
    const expectedBaseline = completed.snapshot();
    const baseline = await completed.inspect();
    let absent = false;
    try { await lstat(this.sessionRoot); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') absent = true; else throw error; }
    // Neither an entry-time process check nor a cached reset receipt proves
    // closure after the filesystem observations have settled.
    await this.assertResetInspectionSafe();
    if (this.completedBaseline !== completed || this.created || this.started) throw new Error('REAPER_RESET_INSPECTION_UNAVAILABLE');
    return { scope: 'adapter-settings-only', baselineCompared: baseline.matches, targetClosed: true,
      sessionAbsent: absent, baseline, expectedBaseline };
  }
}
