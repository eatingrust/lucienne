import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { statSync, lstatSync } from 'node:fs';
import { access, mkdir, cp, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CommitContext } from '../../contracts/ports.js';
import { KritaBaseline, type KritaBaselineSnapshot } from './baseline.js';
import { KritaBridge, KRITA_STARTUP_TIMEOUT_MS, assertCurrent, type BridgeCommand } from './transport.js';
import type { Operation } from '../../contracts/index.js';
import { readPluginDiagnostics } from './diagnostics.js';
import { KritaLoaderDiagnostics, KRITA_SCRIPT_LOGGING_RULES } from './loader-diagnostics.js';

const exec = promisify(execFile);
export const DEFAULT_KRITA_APP = '/PUBLIC_NATIVE_APPS_REQUIRED/krita.app';
export interface KritaRuntimeOptions {
  sessionRoot?: string;
  appPath?: string;
  pluginDirectory?: string;
}
export interface NativeHello {
  nativeVersion: string; baselineFingerprint: string; pid: number; account: string; documentCount: number;
  /** Host-measured spawn-to-validated-hello time, persisted in the apply receipt. */
  startupElapsedMs?: number;
}
/** Both the launcher and native bridge check the effective user and current console.
 * Changing HOME/XDG variables never counts as macOS preference isolation. */
export function assertDemoAccount(): void {
  const user = userInfo();
  if (process.platform !== 'darwin') throw new Error('KRITA_MACOS_REQUIRED');
  if (user.username !== 'lucienne' || user.homedir !== '/PUBLIC_NATIVE_HOME_REQUIRED' || process.geteuid?.() !== user.uid)
    throw new Error('KRITA_DEMO_PROCESS_REQUIRED');
  if (statSync('/dev/console').uid !== user.uid) throw new Error('KRITA_DEMO_CONSOLE_REQUIRED');
}
export function assertNoSymlinkPath(target: string): void {
  if (!path.isAbsolute(target)) throw new Error('KRITA_ABSOLUTE_PATH_REQUIRED');
  const parts = path.resolve(target).split(path.sep).filter(Boolean);
  let cursor = path.parse(target).root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try { if (lstatSync(cursor).isSymbolicLink()) throw new Error('KRITA_SYMLINK_PATH'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function enableBridgeConfig(input: string, resourceDirectory: string): string {
  if (!path.isAbsolute(resourceDirectory) || /[\x00-\x1f\x7f\\]/.test(resourceDirectory))
    throw new Error('KRITA_INVALID_RESOURCE_DIRECTORY');
  // Descriptor discovery honors --resource-location; Python's sys.path also
  // uses saveLocation(), which reads this global KConfig entry. Both must agree.
  let globalGroup = true;
  const lines = input.split(/\r?\n/).filter(line => {
    if (/^\s*\[/.test(line)) globalGroup = false;
    return !(globalGroup && /^\s*ResourceDirectory(?:\[\$[ie]\])*\s*=/.test(line));
  });
  lines.unshift(`ResourceDirectory=${path.resolve(resourceDirectory)}`);
  let inPython = false, found = false, inserted = false;
  const output: string[] = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (inPython && !inserted) { output.push('enable_lucienne_bridge=true'); inserted = true; }
      inPython = /^\[python\]\s*$/.test(line);
      found ||= inPython;
    }
    if (inPython && /^\s*enable_lucienne_bridge\s*=/.test(line)) {
      if (!inserted) output.push('enable_lucienne_bridge=true');
      inserted = true;
    } else output.push(line);
  }
  if (!found) output.push('', '[python]', 'enable_lucienne_bridge=true');
  else if (inPython && !inserted) output.push('enable_lucienne_bridge=true');
  return `${output.join('\n').replace(/\n+$/, '')}\n`;
}
/** Explicit native-child allowlist: no inherited provider keys or Python/DYLD overrides. */
export function kritaChildEnvironment(home: string, sessionRoot: string, bridgeDirectory: string, token: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: 'lucienne', LOGNAME: 'lucienne',
    LANG: 'en_US.UTF-8', TMPDIR: `${path.join(sessionRoot, 'tmp')}/`,
    // Krita embeds normal Py_InitializeEx; prevent imports rewriting signed bundle caches.
    PYTHONDONTWRITEBYTECODE: '1',
    // Fixed scripting/plugin/startup markers; host keeps codes, never raw logs.
    QT_LOGGING_RULES: KRITA_SCRIPT_LOGGING_RULES,
    QT_FORCE_STDERR_LOGGING: '1',
    QT_MESSAGE_PATTERN: '%{if-category}%{category}: %{endif}%{message}',
    LUCIENNE_KRITA_BRIDGE_DIR: bridgeDirectory, LUCIENNE_KRITA_TOKEN: token,
  };
}
async function noExistingKrita(): Promise<void> {
  try { const { stdout } = await exec('/usr/bin/pgrep', ['-x', 'krita']); if (stdout.trim()) throw new Error('KRITA_ALREADY_RUNNING'); }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class KritaRuntime {
  readonly sessionRoot: string;
  readonly appPath: string;
  private readonly pluginDirectory: string;
  private child?: ChildProcess;
  private exitPromise?: Promise<void>;
  private closed = true;
  private bridge?: KritaBridge;
  private baseline?: KritaBaseline;
  private completedBaseline?: KritaBaseline;
  private hello?: NativeHello;
  private createdSession = false;
  private startAttempted = false;
  private preferencesTouched = false;
  private unownedStateDetected = false;
  private stopPromise?: Promise<void>;
  private diagnosticStage = 'idle';
  private loaderDiagnostics = new KritaLoaderDiagnostics();
  constructor(options: KritaRuntimeOptions = {}) {
    const appPath = options.appPath ?? DEFAULT_KRITA_APP;
    const sessionRoot = options.sessionRoot ?? path.join(userInfo().homedir, 'Library/Application Support/Lucienne/krita-session');
    const pluginDirectory = options.pluginDirectory ?? fileURLToPath(new URL('./plugin/', import.meta.url));
    for (const file of [appPath, sessionRoot, pluginDirectory]) if (!path.isAbsolute(file) || file.includes('\0')) throw new Error('KRITA_ABSOLUTE_PATH_REQUIRED');
    this.appPath = path.resolve(appPath);
    this.sessionRoot = path.resolve(sessionRoot);
    this.pluginDirectory = path.resolve(pluginDirectory);
  }
  getBaselineSnapshot(): KritaBaselineSnapshot {
    const baseline = this.baseline ?? this.completedBaseline;
    if (!baseline) throw new Error('KRITA_BASELINE_UNAVAILABLE');
    return baseline.snapshot();
  }
  async getDiagnostics() {
    const file = path.join(this.sessionRoot, 'bridge/status.json');
    let plugin: Awaited<ReturnType<typeof readPluginDiagnostics>> | { state: 'not-started' } = { state: 'not-started' };
    if (this.createdSession) {
      try { assertNoSymlinkPath(file); plugin = await readPluginDiagnostics(file); }
      catch { plugin = { state: 'unavailable' }; }
    }
    return { stage: this.diagnosticStage, processClosed: this.closed,
      sessionCreated: this.createdSession, handshakeAccepted: !!this.hello,
      command: this.bridge?.getDiagnostics() ?? null,
      plugin, loader: this.loaderDiagnostics.snapshot() };
  }
  async inspectReset(): Promise<{
    baselineCompared: boolean; visitorStateCleared: boolean; recentsCleared: boolean;
    targetClosed: boolean; sessionAbsent: boolean; current: Awaited<ReturnType<KritaBaseline['inspect']>>;
  }> {
    assertDemoAccount();
    if (this.createdSession || !this.completedBaseline) throw new Error('KRITA_RESET_NOT_COMPLETED');
    await noExistingKrita(); assertDemoAccount();
    const current = await this.completedBaseline.inspect();
    let sessionAbsent = false;
    try { await lstat(this.sessionRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') sessionAbsent = true; else throw error; }
    await noExistingKrita(); assertDemoAccount();
    return { baselineCompared: current.matches, visitorStateCleared: current.matches && sessionAbsent,
      recentsCleared: current.matches, targetClosed: true, sessionAbsent, current };
  }
  async preflight(): Promise<{ account: 'lucienne'; appPath: string; sessionRoot: string }> {
    assertDemoAccount();
    for (const file of [this.appPath, this.sessionRoot, this.pluginDirectory]) assertNoSymlinkPath(file);
    const home = userInfo().homedir;
    if (!this.sessionRoot.startsWith(`${home}/Library/Application Support/Lucienne/`) || this.sessionRoot.includes('\0'))
      throw new Error('KRITA_SESSION_PATH_OUTSIDE_DEMO_ROOT');
    await access(path.join(this.appPath, 'Contents/MacOS/krita'), constants.X_OK);
    await access(path.join(this.pluginDirectory, 'lucienne_bridge.desktop'), constants.R_OK);
    await noExistingKrita();
    assertDemoAccount();
    try { await lstat(this.sessionRoot); throw new Error('KRITA_RECOVERY_REQUIRED'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return { account: 'lucienne', appPath: this.appPath, sessionRoot: this.sessionRoot };
  }
  async start(context: CommitContext): Promise<NativeHello> {
    assertCurrent(context); assertDemoAccount();
    if (this.hello) return structuredClone(this.hello);
    if (this.startAttempted) throw new Error('KRITA_RESET_REQUIRED');
    this.diagnosticStage = 'preflight';
    await this.preflight(); assertCurrent(context); assertDemoAccount();
    this.startAttempted = true;
    await mkdir(path.dirname(this.sessionRoot), { recursive: true, mode: 0o700 });
    assertCurrent(context); assertDemoAccount(); assertNoSymlinkPath(this.sessionRoot);
    await mkdir(this.sessionRoot, { mode: 0o700 }); this.createdSession = true;
    assertCurrent(context); assertDemoAccount();
    this.diagnosticStage = 'baseline-capture';
    this.baseline = await KritaBaseline.capture({ home: userInfo().homedir, backupDirectory: path.join(this.sessionRoot, 'baseline') });
    assertCurrent(context); assertDemoAccount();
    this.diagnosticStage = 'install-plugin';
    const resources = path.join(this.sessionRoot, 'resources'), bridgeDirectory = path.join(this.sessionRoot, 'bridge');
    await mkdir(path.join(resources, 'pykrita'), { recursive: true, mode: 0o700 });
    await mkdir(bridgeDirectory, { mode: 0o700 });
    await mkdir(path.join(this.sessionRoot, 'tmp'), { mode: 0o700 });
    // Only reviewed plugin assets are copied. Tests/README never enter the native loader.
    await cp(path.join(this.pluginDirectory, 'lucienne_bridge'), path.join(resources, 'pykrita/lucienne_bridge'), { recursive: true, dereference: false });
    await cp(path.join(this.pluginDirectory, 'lucienne_bridge.desktop'), path.join(resources, 'pykrita/lucienne_bridge.desktop'));
    assertCurrent(context); assertDemoAccount();
    this.diagnosticStage = 'config-write';
    const config = path.join(userInfo().homedir, 'Library/Preferences/kritarc');
    const original = await readFile(config, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    assertCurrent(context); assertDemoAccount(); assertNoSymlinkPath(config);
    const temp = path.join(path.dirname(config), `kritarc.${randomUUID()}.tmp`);
    await writeFile(temp, enableBridgeConfig(original, resources), { mode: 0o600, flag: 'wx' });
    try { assertCurrent(context); assertDemoAccount(); this.preferencesTouched = true; await rename(temp, config); }
    finally { await rm(temp, { force: true }); }
    assertCurrent(context); assertDemoAccount();
    await noExistingKrita(); assertCurrent(context); assertDemoAccount();
    const token = randomBytes(32).toString('hex');
    const executable = path.join(this.appPath, 'Contents/MacOS/krita');
    const env = kritaChildEnvironment(userInfo().homedir, this.sessionRoot, bridgeDirectory, token);
    this.diagnosticStage = 'spawn';
    this.loaderDiagnostics = new KritaLoaderDiagnostics();
    this.closed = false;
    // A fresh owned resource directory requires Krita's cold resource setup before
    // Python can answer hello. One monotonic budget includes spawn and all window
    // readiness retries; later bridge commands retain their normal 20-second cap.
    const startupStarted = performance.now();
    const startupDeadline = startupStarted + KRITA_STARTUP_TIMEOUT_MS;
    const child = spawn(executable, ['--nosplash', '--resource-location', resources], {
      cwd: this.sessionRoot, env, stdio: ['ignore', 'ignore', 'pipe'], detached: true,
    });
    // Always drain stderr, including after classification limits. Never write raw
    // chunks to console, files, native evidence or provider requests.
    child.stderr?.on('data', chunk => this.loaderDiagnostics.consume(chunk));
    child.stderr?.once('end', () => this.loaderDiagnostics.finish());
    child.stderr?.once('error', () => this.loaderDiagnostics.finish());
    this.child = child;
    this.exitPromise = new Promise<void>(resolve => {
      child.once('error', () => { this.closed = true; resolve(); });
      child.once('close', () => { this.closed = true; resolve(); });
    });
    this.bridge = new KritaBridge({ directory: bridgeDirectory, token, startupDeadline,
      process: { exited: () => {
        try { return this.closed && (!child.pid || !groupAlive(child.pid)); } catch { return false; }
      }, terminate: () => this.terminate() }, assertAccount: assertDemoAccount });
    this.diagnosticStage = 'hello';
    let hello: NativeHello;
    for (;;) {
      try { hello = await this.bridge.command<NativeHello>('hello', context); break; }
      catch (error) {
        if (error instanceof Error && ['EXISTING_DOCUMENTS', 'EXISTING_WINDOWS'].includes(error.message)) this.unownedStateDetected = true;
        if (!(error instanceof Error) || error.message !== 'WINDOW_NOT_READY') throw error;
        // The transport owns expiry/revocation/drain, including a retry whose
        // deadline has already elapsed. Never grant a new budget per retry.
        await delay(Math.min(75, Math.max(0, startupDeadline - performance.now())));
        assertCurrent(context); assertDemoAccount();
      }
    }
    assertCurrent(context); assertDemoAccount();
    if (!hello || !/^5\.3\.4(?:[.\s-]|$)/.test(hello.nativeVersion) || hello.account !== 'lucienne' ||
        hello.pid !== child.pid || hello.documentCount !== 0 || !/^[a-f0-9]{64}$/.test(hello.baselineFingerprint))
      throw new Error('KRITA_NATIVE_HANDSHAKE_INVALID');
    this.hello = { ...hello, startupElapsedMs: Math.max(0, Math.round(performance.now() - startupStarted)) };
    this.diagnosticStage = 'ready';
    return structuredClone(this.hello);
  }
  async command<T>(command: BridgeCommand, context: CommitContext, operations?: readonly Operation[]): Promise<T> {
    if (!this.bridge || this.closed) throw new Error('KRITA_NOT_RUNNING');
    this.diagnosticStage = command;
    return this.bridge.command<T>(command, context, operations);
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
      // A child exit alone is insufficient if a descendant still holds the writer group.
      while (groupAlive(pid)) { send('SIGKILL'); await delay(25); }
      if (signalError) throw signalError;
    } finally { clearTimeout(kill); }
  }
  async reset(context: CommitContext): Promise<{
    targetClosed: boolean; preferencesRestored: boolean; visitorArtifactsCleared: boolean;
    manifestDigest: string | null; nativeRestoration: unknown; baselineFingerprint?: string;
  }> {
    let nativeRestoration: unknown = null;
    if (!this.createdSession) {
      assertDemoAccount();
      await noExistingKrita(); assertDemoAccount();
      this.startAttempted = false;
      // No native configuration was touched. Closure is still freshly verified;
      // a failed preflight never authorizes closing an unowned process.
      return { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true,
        manifestDigest: null, nativeRestoration: { noSessionStarted: true } };
    }
    assertDemoAccount();
    if (!this.baseline && !this.preferencesTouched && !this.child) {
      await noExistingKrita(); assertDemoAccount();
      assertNoSymlinkPath(this.sessionRoot);
      await rm(this.sessionRoot, { recursive: true });
      this.createdSession = false;
      await noExistingKrita(); assertDemoAccount();
      this.startAttempted = false;
      return { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true,
        manifestDigest: null, nativeRestoration: { startupCancelledBeforeNativeWrite: true } };
    }
    if (this.unownedStateDetected && !this.closed) throw new Error('KRITA_UNOWNED_STATE_REQUIRES_OPERATOR');
    if (this.bridge && !this.closed) {
      try {
        nativeRestoration = await this.bridge.command('restore', context);
        await this.bridge.command('close', context);
        // Normal exit is preferred, but a hung native quit is killed and fully reaped.
        const force = setTimeout(() => { void this.terminate().catch(() => undefined); }, 3000);
        try { await this.exitPromise; } finally { clearTimeout(force); }
      } catch (error) {
        if (error instanceof Error && ['UNOWNED_DOCUMENTS_PRESENT', 'DOCUMENTS_STILL_OPEN'].includes(error.message)) {
          this.unownedStateDetected = true;
          throw new Error('KRITA_UNOWNED_STATE_REQUIRES_OPERATOR');
        }
        await this.terminate();
      }
    }
    await this.terminate(); assertDemoAccount();
    if (!this.closed || !this.isQuiescent()) throw new Error('KRITA_NOT_QUIESCENT');
    if (!this.baseline) throw new Error('KRITA_BASELINE_UNAVAILABLE');
    await noExistingKrita(); assertDemoAccount();
    const restored = await this.baseline.restore();
    assertDemoAccount();
    if (!restored.preferencesRestored || !restored.visitorArtifactsCleared || !(await this.baseline.verify()))
      throw new Error('KRITA_BASELINE_RESTORE_FAILED');
    // The only removed tree is the owned, newly created session with preserved baseline already verified.
    assertNoSymlinkPath(this.sessionRoot);
    await rm(path.join(this.sessionRoot, 'resources'), { recursive: true, force: true });
    await rm(path.join(this.sessionRoot, 'tmp'), { recursive: true, force: true });
    await rm(path.join(this.sessionRoot, 'bridge'), { recursive: true, force: true });
    const result = { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true,
      manifestDigest: restored.manifestDigest, nativeRestoration, baselineFingerprint: this.hello?.baselineFingerprint };
    await noExistingKrita(); assertDemoAccount();
    if (!(await this.baseline.verify())) throw new Error('KRITA_BASELINE_CHANGED_AFTER_RESET');
    await rm(this.sessionRoot, { recursive: true });
    this.completedBaseline = this.baseline;
    this.child = undefined; this.bridge = undefined; this.baseline = undefined; this.hello = undefined;
    this.createdSession = false; this.startAttempted = false; this.preferencesTouched = false; this.unownedStateDetected = false;
    return result;
  }
}
