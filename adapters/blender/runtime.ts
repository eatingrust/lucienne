import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { statSync, lstatSync, constants } from 'node:fs';
import { access, mkdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { CommitContext } from '../../contracts/ports.js';
import type { Operation } from '../../contracts/index.js';
import { BlenderBaseline, type BlenderBaselineSnapshot } from './baseline.js';
import { BlenderBridge, assertCurrent, type BridgeCommand } from './transport.js';
import { activateBlenderWindow, observeBlenderWindow } from './window-probe.js';
import { NativeReadbackSchema } from '../../contracts/ports.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export const DEFAULT_BLENDER_APP = '/PUBLIC_NATIVE_APPS_REQUIRED/Blender.app';
export interface BlenderRuntimeOptions { sessionRoot?: string; appPath?: string; nativeDirectory?: string; windowProbePath?: string }
export interface NativeHello { nativeVersion: string; pid: number; account: string; baselineFingerprint: string }

/** HOME overrides do not count as native macOS account isolation. */
export function assertDemoAccount(): void {
  const user = userInfo();
  if (process.platform !== 'darwin') throw new Error('BLENDER_MACOS_REQUIRED');
  if (user.username !== 'lucienne' || user.homedir !== '/PUBLIC_NATIVE_HOME_REQUIRED' || process.geteuid?.() !== user.uid)
    throw new Error('BLENDER_DEMO_PROCESS_REQUIRED');
  if (statSync('/dev/console').uid !== user.uid) throw new Error('BLENDER_DEMO_CONSOLE_REQUIRED');
}
export function assertNoSymlinkPath(target: string): void {
  if (!path.isAbsolute(target)) throw new Error('BLENDER_ABSOLUTE_PATH_REQUIRED');
  let cursor = path.parse(target).root;
  for (const part of path.resolve(target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('BLENDER_SYMLINK_PATH'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
/** Only reviewed runtime inputs: no provider credentials, PYTHONPATH or DYLD inherited. */
export function blenderChildEnvironment(home: string, sessionRoot: string, bridgeDirectory: string, token: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: 'lucienne', LOGNAME: 'lucienne', LANG: 'en_US.UTF-8',
    TMPDIR: `${path.join(sessionRoot, 'tmp')}/`, PYTHONDONTWRITEBYTECODE: '1',
    BLENDER_USER_RESOURCES: path.join(sessionRoot, 'resources'), BLENDER_USER_CONFIG: path.join(sessionRoot, 'config'),
    BLENDER_USER_SCRIPTS: path.join(sessionRoot, 'scripts'), BLENDER_USER_DATAFILES: path.join(sessionRoot, 'datafiles'),
    LUCIENNE_BLENDER_BRIDGE_DIR: bridgeDirectory, LUCIENNE_BLENDER_TOKEN: token };
}
async function noExistingBlender(): Promise<void> {
  try { const { stdout } = await exec('/usr/bin/pgrep', ['-ix', 'blender']); if (stdout.trim()) throw new Error('BLENDER_ALREADY_RUNNING'); }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

/** A fresh process may not claim a previous crash's session is clean. */
export async function assertSessionAbsent(sessionRoot: string): Promise<void> {
  assertNoSymlinkPath(sessionRoot);
  try { await lstat(sessionRoot); throw new Error('BLENDER_RECOVERY_REQUIRED'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export class BlenderRuntime {
  readonly sessionRoot: string;
  readonly appPath: string;
  private readonly nativeDirectory: string;
  private readonly windowProbePath: string;
  private child?: ChildProcess;
  private exitPromise?: Promise<void>;
  private closed = true;
  private bridge?: BlenderBridge;
  private baseline?: BlenderBaseline;
  private completedBaseline?: BlenderBaseline;
  private hello?: NativeHello;
  private createdSession = false;
  private startAttempted = false;
  private unownedStateDetected = false;
  private stopPromise?: Promise<void>;
  constructor(options: BlenderRuntimeOptions = {}) {
    this.appPath = options.appPath ?? DEFAULT_BLENDER_APP;
    this.sessionRoot = options.sessionRoot ?? path.join(userInfo().homedir, 'Library/Application Support/Lucienne/blender-session');
    this.nativeDirectory = options.nativeDirectory ?? fileURLToPath(new URL('./native/', import.meta.url));
    this.windowProbePath = options.windowProbePath ?? fileURLToPath(new URL('./window-probe', import.meta.url));
    for (const file of [this.appPath, this.sessionRoot, this.nativeDirectory, this.windowProbePath])
      if (!path.isAbsolute(file) || file.includes('\0') || path.resolve(file) !== file.replace(/\/$/, ''))
        throw new Error('BLENDER_ABSOLUTE_NORMALIZED_PATH_REQUIRED');
  }
  getBaselineSnapshot(): BlenderBaselineSnapshot {
    const baseline = this.baseline ?? this.completedBaseline;
    if (!baseline) throw new Error('BLENDER_BASELINE_UNAVAILABLE');
    return baseline.snapshot();
  }
  async inspectReset() {
    assertDemoAccount();
    if (this.createdSession || !this.completedBaseline) throw new Error('BLENDER_RESET_NOT_COMPLETED');
    await noExistingBlender(); assertDemoAccount();
    const current = await this.completedBaseline.inspect();
    let sessionAbsent = false;
    try { await lstat(this.sessionRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') sessionAbsent = true; else throw error; }
    await noExistingBlender(); assertDemoAccount();
    return { baselineCompared: current.matches, visitorStateCleared: current.matches && sessionAbsent,
      recentsCleared: current.matches, targetClosed: true, sessionAbsent, current };
  }
  async preflight() {
    assertDemoAccount();
    for (const file of [this.appPath, this.sessionRoot, this.nativeDirectory, this.windowProbePath]) assertNoSymlinkPath(file);
    const home = userInfo().homedir;
    if (!this.sessionRoot.startsWith(`${home}/Library/Application Support/Lucienne/`)) throw new Error('BLENDER_SESSION_PATH_OUTSIDE_DEMO_ROOT');
    await access(path.join(this.appPath, 'Contents/MacOS/Blender'), constants.X_OK);
    await access(path.join(this.nativeDirectory, 'bootstrap.py'), constants.R_OK);
    await access(this.windowProbePath, constants.X_OK);
    await access(path.join(this.nativeDirectory, '../catalog.json'), constants.R_OK);
    await noExistingBlender(); assertDemoAccount();
    await assertSessionAbsent(this.sessionRoot);
    return { account: 'lucienne' as const, appPath: this.appPath, sessionRoot: this.sessionRoot };
  }
  async start(context: CommitContext): Promise<NativeHello> {
    assertCurrent(context); assertDemoAccount();
    if (this.hello) return structuredClone(this.hello);
    if (this.startAttempted) throw new Error('BLENDER_RESET_REQUIRED');
    await this.preflight(); assertCurrent(context); assertDemoAccount();
    this.startAttempted = true;
    await mkdir(path.dirname(this.sessionRoot), { recursive: true, mode: 0o700 });
    assertCurrent(context); assertDemoAccount(); assertNoSymlinkPath(this.sessionRoot);
    await mkdir(this.sessionRoot, { mode: 0o700 }); this.createdSession = true;
    assertCurrent(context); assertDemoAccount();
    this.baseline = await BlenderBaseline.capture({ home: userInfo().homedir, backupDirectory: path.join(this.sessionRoot, 'baseline') });
    assertCurrent(context); assertDemoAccount();
    for (const name of ['resources', 'config', 'scripts', 'datafiles', 'tmp', 'bridge']) {
      assertCurrent(context); await mkdir(path.join(this.sessionRoot, name), { mode: 0o700 });
    }
    await noExistingBlender(); assertCurrent(context); assertDemoAccount();
    const token = randomBytes(32).toString('hex'), bridgeDirectory = path.join(this.sessionRoot, 'bridge');
    this.closed = false;
    const child = spawn(path.join(this.appPath, 'Contents/MacOS/Blender'),
      ['--factory-startup', '--disable-autoexec', '--no-splash', '--python', path.join(this.nativeDirectory, 'bootstrap.py')], {
        cwd: this.sessionRoot, env: blenderChildEnvironment(userInfo().homedir, this.sessionRoot, bridgeDirectory, token),
        stdio: 'ignore', detached: true,
      });
    this.child = child;
    this.exitPromise = new Promise<void>(resolve => {
      child.once('error', () => { this.closed = true; resolve(); });
      child.once('close', () => { this.closed = true; resolve(); });
    });
    this.bridge = new BlenderBridge({ directory: bridgeDirectory, token,
      process: { exited: () => {
        try { return this.closed && (!child.pid || !groupAlive(child.pid)); } catch { return false; }
      }, terminate: () => this.terminate() }, assertAccount: assertDemoAccount });
    let hello: NativeHello;
    const deadline = Date.now() + 30_000;
    for (;;) {
      try { hello = await this.bridge.command<NativeHello>('hello', context); break; }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'WINDOW_NOT_READY' || Date.now() >= deadline) throw error;
        await delay(75); assertCurrent(context); assertDemoAccount();
      }
    }
    assertCurrent(context); assertDemoAccount();
    if (!hello || !/^5\.2\.3(?:[.\s-]|$)/.test(hello.nativeVersion) || hello.account !== 'lucienne' || hello.pid !== child.pid ||
        !/^[a-f0-9]{64}$/.test(hello.baselineFingerprint)) throw new Error('BLENDER_NATIVE_HANDSHAKE_INVALID');
    this.hello = hello; return structuredClone(hello);
  }
  /** Explicit native focus handoff belongs to apply, never to observational readback. */
  async focus(context: CommitContext): Promise<void> {
    assertCurrent(context); assertDemoAccount();
    if (!this.child?.pid || this.closed) throw new Error('BLENDER_PROCESS_EXITED');
    let window = await activateBlenderWindow(this.windowProbePath, this.child.pid, context);
    const deadline = Date.now() + 2000;
    while (!window.visible && Date.now() < deadline) {
      await delay(50); assertCurrent(context); assertDemoAccount();
      window = await observeBlenderWindow(this.windowProbePath, this.child.pid, context);
    }
    assertCurrent(context); assertDemoAccount();
    if (!window.visible) throw new Error('BLENDER_FOCUS_NOT_CONFIRMED');
  }
  async command<T>(command: BridgeCommand, context: CommitContext, operations?: readonly Operation[]): Promise<T> {
    if (!this.bridge || this.closed) throw new Error('BLENDER_NOT_RUNNING');
    const result = await this.bridge.command<T>(command, context, operations);
    if (command !== 'readback') return result;
    assertCurrent(context); assertDemoAccount();
    if (!this.child?.pid) throw new Error('BLENDER_PROCESS_EXITED');
    const native = NativeReadbackSchema.parse(result);
    const window = await observeBlenderWindow(this.windowProbePath, this.child.pid, context);
    assertCurrent(context); assertDemoAccount();
    return { ...native, targetVisible: native.targetVisible && window.visible,
      interactive: native.interactive && window.visible } as T;
  }
  isQuiescent(): boolean { return this.bridge?.isQuiescent() ?? true; }
  async terminate(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwnedProcess();
    try { await this.stopPromise; } finally { this.stopPromise = undefined; }
  }
  private async stopOwnedProcess(): Promise<void> {
    const pid = this.child?.pid;
    if (!pid) { await this.exitPromise; return; }
    const send = (signal: NodeJS.Signals) => {
      if (!groupAlive(pid)) return;
      try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    send('SIGTERM');
    let signalError: unknown;
    const kill = setTimeout(() => { try { send('SIGKILL'); } catch (error) { signalError = error; } }, 1500);
    try {
      await this.exitPromise;
      while (groupAlive(pid)) { send('SIGKILL'); await delay(25); }
      if (signalError) throw signalError;
    } finally { clearTimeout(kill); }
  }
  async reset(context: CommitContext) {
    assertDemoAccount();
    if (!this.createdSession) {
      await noExistingBlender(); assertDemoAccount();
      await assertSessionAbsent(this.sessionRoot); assertDemoAccount();
      this.startAttempted = false;
      return { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true,
        manifestDigest: null, nativeRestoration: { noSessionStarted: true } };
    }
    if (this.unownedStateDetected) throw new Error('BLENDER_UNOWNED_STATE_REQUIRES_OPERATOR');
    let nativeRestoration: unknown = null;
    if (this.bridge && !this.closed) {
      try {
        nativeRestoration = await this.bridge.command('restore', context);
        await this.bridge.command('close', context);
        const force = setTimeout(() => { void this.terminate().catch(() => undefined); }, 3000);
        try { await this.exitPromise; } finally { clearTimeout(force); }
      } catch (error) {
        if (error instanceof Error && error.message === 'UNOWNED_DOCUMENTS_PRESENT') {
          this.unownedStateDetected = true; throw new Error('BLENDER_UNOWNED_STATE_REQUIRES_OPERATOR');
        }
        await this.terminate();
      }
    }
    // Always drain the entire owned process group, including descendants after leader exit.
    await this.terminate(); await noExistingBlender(); assertDemoAccount();
    const restored = this.baseline ? await this.baseline.restore() :
      { preferencesRestored: true, visitorArtifactsCleared: true, manifestDigest: null };
    assertDemoAccount();
    if (!restored.preferencesRestored || !restored.visitorArtifactsCleared) throw new Error('BLENDER_BASELINE_MISMATCH');
    assertNoSymlinkPath(this.sessionRoot);
    await rm(this.sessionRoot, { recursive: true });
    await noExistingBlender(); assertDemoAccount();
    this.completedBaseline = this.baseline ?? this.completedBaseline;
    this.baseline = undefined; this.bridge = undefined; this.child = undefined; this.exitPromise = undefined;
    this.hello = undefined; this.closed = true; this.createdSession = false; this.startAttempted = false;
    return { targetClosed: true, ...restored, nativeRestoration };
  }
}
