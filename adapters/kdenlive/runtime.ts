import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommitContext, NativeReadback, NativeResetResult } from '../../contracts/ports.js';
import type { NativePatch, PlannerRequest, SourceApp } from '../../contracts/index.js';
import { assertCurrent, type KdenliveDriver } from './index.js';
import { KdenliveBaseline, assertKdenliveSafePath } from './baseline.js';
import { KdenliveRecoveryStore } from './recovery.js';
import { assertCalibration, chooseLayout, layoutsConfig, shortcutXml, type KdenliveCalibration } from './config.js';
import { observeOperations, type NativeSnapshot } from './observation.js';
import { kdenliveCatalog } from './catalog.js';
import { writePreparedProject } from './project.js';
export const KDENLIVE_EXECUTABLE = '/PUBLIC_NATIVE_APPS_REQUIRED/kdenlive.app/Contents/MacOS/kdenlive';
export const KDENLIVE_NATIVE_BASELINE = '/PUBLIC_NATIVE_BASELINE_REQUIRED';
export interface KdenliveRuntimeOptions {
  calibration: KdenliveCalibration;
  observerExecutable: string; menuExecutable: string;
  sessionParent: string; evidenceDirectory: string; buildId: string;
  startupTimeoutMs?: number;
}
export interface KdenliveRecoveryOptions {sessionParent: string; evidenceDirectory: string; buildId: string}
interface EvidenceArtifact {id: string; path: string; sha256: string}
const recoveryDirectory = (sessionParent: string) => path.join(sessionParent,'.kdenlive-recovery');
function validateStorageOptions(options: KdenliveRecoveryOptions): void {
  for (const p of [options.sessionParent, options.evidenceDirectory]) assertKdenliveSafePath(p);
  if (options.evidenceDirectory === options.sessionParent || options.evidenceDirectory.startsWith(`${options.sessionParent}/`) ||
    !/^[a-zA-Z0-9._:/-]{1,160}$/.test(options.buildId)) throw new Error('KDENLIVE_INVALID_RUNTIME_OPTIONS');
}
function writeEvidence(options: KdenliveRecoveryOptions, kind: string, identity: {runId: string; requestId?: string; generation?: number}, observation: unknown): EvidenceArtifact {
  assertKdenliveSafePath(options.evidenceDirectory);
  mkdirSync(options.evidenceDirectory, {recursive:true, mode:0o700});
  const id = `kdenlive:${randomUUID()}`, file = path.join(options.evidenceDirectory, `${id.slice(9)}.json`);
  const bytes = JSON.stringify({version:1,id,kind,buildId:options.buildId,evidenceKind:'native',...identity,observedAt:new Date().toISOString(),observation});
  writeFileSync(file,bytes,{flag:'wx',mode:0o600});
  return {id,path:file,sha256:createHash('sha256').update(bytes).digest('hex')};
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export function assertKdenliveAccount(): void {
  if (process.platform !== 'darwin' || process.getuid?.() !== 502 || process.geteuid?.() !== 502 || os.userInfo().username !== 'lucienne' || os.homedir() !== '/PUBLIC_NATIVE_HOME_REQUIRED')
    throw new Error('KDENLIVE_WRONG_ACCOUNT');
  if (statSync('/dev/console').uid !== 502) throw new Error('KDENLIVE_WRONG_CONSOLE');
}
function runningPids(): number[] {
  try { return execFileSync('/usr/bin/pgrep', ['-x', 'kdenlive'], {encoding: 'utf8', timeout: 2000}).trim().split(/\s+/).filter(Boolean).map(Number); }
  catch (error) { if ((error as {status?:number}).status === 1) return []; throw new Error('KDENLIVE_PROCESS_INVENTORY_FAILED'); }
}
function assertClosed(): void {
  assertKdenliveAccount();
  if (runningPids().length) throw new Error('KDENLIVE_TARGET_ALREADY_RUNNING');
}
/** Cold-host recovery deliberately requires neither calibration nor AX helpers.
 * The sole native-lane owner must first close an orphan app through its proven
 * ownership path. This function never kills a PID recovered from a journal. */
export function recoverKdenliveSession(input: KdenliveRecoveryOptions):
  {recovered:false} | {recovered:true;runId:string;result:NativeResetResult;artifacts:EvidenceArtifact[];retainedArchive?:string} {
  const options = {...input}; validateStorageOptions(options); assertClosed();
  const directory = recoveryDirectory(options.sessionParent);
  const runId = KdenliveRecoveryStore.pendingRun(directory,assertClosed);
  if (runId === undefined) return {recovered:false};
  const sessionDirectory = path.join(options.sessionParent,createHash('sha256').update(runId).digest('hex').slice(0,24));
  const baseline = KdenliveBaseline.fromRecovery({homeDirectory:'/PUBLIC_NATIVE_HOME_REQUIRED',sessionDirectory,runId,assertClosed,recoveryDirectory:directory});
  const inspection = baseline.restore();
  const cleanup = baseline.finishRecovery(); assertClosed();
  const artifact = writeEvidence(options,'cold-recovery-filesystem-readback',{runId},{...inspection,...cleanup});
  return {recovered:true,runId,...cleanup,artifacts:[artifact],result:{targetClosed:true,preferencesRestored:inspection.preferencesRestored,
    visitorArtifactsCleared:inspection.visitorArtifactsCleared,evidenceRefs:[artifact.id]}};
}
/** Concrete macOS host. No network, session timer, provider or simulated fallback. */
export class KdenliveRuntime implements KdenliveDriver {
  readonly evidenceKind = 'native' as const;
  private readonly calibration: KdenliveCalibration;
  private target?: ChildProcess;
  private targetExit?: Promise<void>;
  private baseline?: KdenliveBaseline;
  private session?: string;
  private runId?: string;
  private bindingDigest?: string;
  private sourceApp?: SourceApp;
  private readonly artifacts: {id: string; path: string; sha256: string}[] = [];
  constructor(private readonly options: KdenliveRuntimeOptions) {
    this.options = {...options};
    this.calibration = structuredClone(options.calibration); assertCalibration(this.calibration);
    for (const p of [options.observerExecutable, options.menuExecutable, options.sessionParent, options.evidenceDirectory]) assertKdenliveSafePath(p);
    validateStorageOptions(options);
  }
  preflight(): void {
    assertClosed();
    if (KdenliveRecoveryStore.pendingRun(recoveryDirectory(this.options.sessionParent),assertClosed) !== undefined) throw new Error('KDENLIVE_RECOVERY_REQUIRED');
    const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.resolve(KDENLIVE_EXECUTABLE, '../../Info.plist')], {encoding:'utf8', timeout:2000}).trim();
    // Canonical bundle reports 24.08; native recorded build/config is 24.08.1.
    if (!['24.08', '24.08.1'].includes(version)) throw new Error('KDENLIVE_WRONG_VERSION');
    for (const helper of [this.options.observerExecutable, this.options.menuExecutable]) {
      if (!statSync(helper).isFile()) throw new Error('KDENLIVE_HELPER_MISSING');
    }
  }
  getEvidenceArtifacts() { return structuredClone(this.artifacts); }
  private evidence(kind: string, identity: {runId: string; requestId?: string; generation: number}, observation: unknown): string[] {
    const artifact = writeEvidence(this.options,kind,identity,observation);
    this.artifacts.push(artifact); return [artifact.id];
  }
  private async stopTarget(): Promise<void> {
    const child = this.target;
    if (!child?.pid) return;
    const pid = child.pid;
    // The detached child owns this process group. Never signal by app name.
    const groupAlive = () => {try {process.kill(-pid, 0); return true;} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error;}};
    if (groupAlive()) { try {process.kill(-pid, 'SIGTERM');} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;} }
    let deadline = Date.now() + 2000;
    while (groupAlive() && Date.now() < deadline) await sleep(25);
    if (groupAlive()) {process.kill(-pid, 'SIGKILL');}
    // Hold native lane until helper descendants are also confirmed gone.
    while (groupAlive()) await sleep(25);
    await this.targetExit;
    this.target = undefined; this.targetExit = undefined;
  }
  private async helper(executable: string, args: string[], context: CommitContext, mutation: boolean): Promise<unknown> {
    assertCurrent(context); assertKdenliveAccount();
    let child: ChildProcess | undefined, output = '', errorOutput = '', aborted = false, timer: ReturnType<typeof setTimeout> | undefined;
    let lease: string | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    const token = randomUUID();
    if (mutation) {
      if (!this.session) throw new Error('KDENLIVE_NO_SESSION');
      lease = path.join(this.session, `lease-${token}.json`);
      assertCurrent(context); assertKdenliveAccount();
      writeFileSync(lease, JSON.stringify({token,runId:context.runId,requestId:context.requestId,generation:context.generation,expiresAt:Date.now()+1500}), {flag:'wx',mode:0o600});
      args = [...args,'--lease',lease,'--token',token,'--run-id',context.runId,'--request-id',context.requestId,'--generation',String(context.generation)];
    }
    const revoke = () => {if (lease) for (const p of [lease,`${lease}.next`]) try {unlinkSync(p);} catch {}};
    const abort = () => {aborted = true; revoke(); child?.kill('SIGKILL');};
    context.signal.addEventListener('abort', abort, {once:true});
    watchdog = setInterval(() => {
      try {
        assertCurrent(context); assertKdenliveAccount();
        if (lease && !aborted) {
          const temp = `${lease}.next`;
          writeFileSync(temp,JSON.stringify({token,runId:context.runId,requestId:context.requestId,generation:context.generation,expiresAt:Date.now()+1500}),{mode:0o600});
          assertCurrent(context); renameSync(temp,lease);
        }
      } catch {abort();}
    },100);
    try {
      assertCurrent(context); assertKdenliveAccount();
      const exit = await new Promise<number | null>((resolve, reject) => {
        child = spawn(executable, args, {stdio:['ignore','pipe','pipe']});
        child.stdout!.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 2_000_000) abort(); });
        child.stderr!.on('data', (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(0,1000); });
        child.once('error', reject); child.once('close', resolve);
        timer = setTimeout(abort, mutation ? 6500 : 8000);
      });
      if (aborted || context.signal.aborted || !context.isCurrent()) {
        // AXPress may already be queued in Kdenlive after the helper dies.
        // Target exit is the only reliable cancellation drain for that case.
        if (mutation) await this.stopTarget();
        throw new Error('KDENLIVE_NATIVE_COMMAND_CANCELLED');
      }
      assertCurrent(context); assertKdenliveAccount();
      let parsed: {ok?: boolean; error?: string};
      try {parsed = JSON.parse(output);} catch {throw new Error('KDENLIVE_INVALID_HELPER_RESPONSE');}
      if (exit !== 0 || parsed.ok !== true) {
        if (mutation) await this.stopTarget();
        throw new Error(typeof parsed.error === 'string' && /^KDENLIVE_[A-Z0-9_]{1,100}$/.test(parsed.error) ? parsed.error : 'KDENLIVE_NATIVE_HELPER_FAILED');
      }
      return parsed;
    } catch (error) {
      if (mutation) await this.stopTarget();
      throw error;
    } finally {if(timer)clearTimeout(timer); if(watchdog)clearInterval(watchdog); revoke(); context.signal.removeEventListener('abort', abort);}
  }
  private async observe(context: CommitContext): Promise<NativeSnapshot> {
    if (!this.target?.pid || this.target.exitCode !== null || this.target.signalCode !== null) throw new Error('KDENLIVE_TARGET_EXITED');
    const pid = this.target.pid;
    const observed = await this.helper(this.options.observerExecutable, ['--pid',String(pid)], context, false) as NativeSnapshot;
    if (observed.pid !== pid) throw new Error('KDENLIVE_OBSERVER_PID_MISMATCH');
    return observed;
  }
  private async press(title: string, context: CommitContext, checked?: boolean): Promise<void> {
    if (!this.target?.pid || !this.session) throw new Error('KDENLIVE_TARGET_EXITED');
    await this.helper(this.options.menuExecutable, ['--pid',String(this.target.pid),'--allowed-titles',path.join(this.session,'allowed-titles.json'),'--title',title,
      ...(checked === undefined ? [] : ['--checked',String(checked)])], context, true);
  }
  async apply(patch: NativePatch, request: PlannerRequest, context: CommitContext): Promise<void> {
    try {await this.applyInternal(patch, request, context);}
    catch (error) {await this.stopTarget(); throw error;}
  }
  private async applyInternal(patch: NativePatch, request: PlannerRequest, context: CommitContext): Promise<void> {
    assertCurrent(context); assertKdenliveAccount();
    const bindings = shortcutXml(this.calibration, patch.operations);
    const digest = createHash('sha256').update(bindings).digest('hex');
    const layout = chooseLayout(this.calibration, patch.operations);
    if (!this.baseline) {
      this.preflight();
      this.runId = context.runId;
      const safeName = createHash('sha256').update(context.runId).digest('hex').slice(0,24);
      this.session = path.join(this.options.sessionParent, safeName);
      const baseline = new KdenliveBaseline({homeDirectory:'/PUBLIC_NATIVE_HOME_REQUIRED',sessionDirectory:this.session,runId:context.runId,assertClosed,
        nativeSeedDirectory:KDENLIVE_NATIVE_BASELINE,recoveryDirectory:recoveryDirectory(this.options.sessionParent)});
      baseline.capture(); this.baseline = baseline; this.sourceApp = request.source.sourceApp;
      assertCurrent(context); this.baseline.claimSession();
      assertCurrent(context); this.baseline.restore({keepSession:true});
      const project = await writePreparedProject({runId:context.runId,source:request.source,directory:path.join(this.session,'project')}, () => {assertCurrent(context);assertClosed();});
      const write = (file: string, contents: string) => {
        assertKdenliveSafePath(file); assertCurrent(context); assertClosed(); mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
        assertCurrent(context); assertClosed(); writeFileSync(file,contents,{mode:0o600});
      };
      write('/PUBLIC_NATIVE_HOME_REQUIRED/Library/Preferences/kdenlive-layoutsrc',layoutsConfig(this.calibration));
      write('/PUBLIC_NATIVE_HOME_REQUIRED/Library/Application Support/kxmlgui5/kdenlive/kdenliveui.rc',bindings);
      write(path.join(this.session,'allowed-titles.json'),JSON.stringify([...new Set(this.calibration.layouts.flatMap(l => [l.menuTitle,...l.toolbarCommands.map(c=>c.title)]))]));
      assertCurrent(context); assertClosed();
      this.target = spawn(KDENLIVE_EXECUTABLE,[project.projectPath],{detached:true,stdio:'ignore'});
      this.targetExit = new Promise(resolve => {this.target!.once('close',()=>resolve());this.target!.once('error',()=>resolve());});
      this.bindingDigest = digest;
      const deadline = Date.now()+(this.options.startupTimeoutMs ?? 30_000);
      let ready = false;
      while (Date.now()<deadline) {
        assertCurrent(context);
        try {const snapshot = await this.observe(context); ready=observeOperations(snapshot,this.calibration.observations,request.catalog).interactive;} catch(error) {assertCurrent(context); if(this.target.exitCode!==null || this.target.signalCode!==null || !(error instanceof Error) || !['KDENLIVE_OBSERVER_AX_WINDOWS_UNAVAILABLE','KDENLIVE_INCOMPLETE_OBSERVATION'].includes(error.message)) throw error;}
        if(ready)break;
        await sleep(100); assertCurrent(context);
      }
      if(!ready)throw new Error('KDENLIVE_NATIVE_READY_TIMEOUT');
    } else if (this.runId !== context.runId || this.bindingDigest !== digest) throw new Error('KDENLIVE_RESTART_REQUIRED');
    await this.press(layout.menuTitle,context);
    for(const command of layout.toolbarCommands) {assertCurrent(context);await this.press(command.title,context,command.checked);}
    assertCurrent(context);
  }
  async readback(context: CommitContext): Promise<NativeReadback> {
    const snapshot = await this.observe(context); assertCurrent(context);
    if (!this.sourceApp) throw new Error('KDENLIVE_NO_SESSION');
    const catalog = kdenliveCatalog(this.sourceApp);
    const observed = observeOperations(snapshot,this.calibration.observations,catalog);
    return {requestId:context.requestId,...observed,evidenceRefs:this.evidence('native-readback',context,snapshot)};
  }
  async reset(identity: {runId:string;generation:number}): Promise<NativeResetResult> {
    if(this.runId && identity.runId!==this.runId)throw new Error('KDENLIVE_RESET_IDENTITY');
    await this.stopTarget(); assertClosed();
    if(!this.baseline) {
      if (KdenliveRecoveryStore.pendingRun(recoveryDirectory(this.options.sessionParent),assertClosed) !== undefined) throw new Error('KDENLIVE_RECOVERY_REQUIRED');
      return {targetClosed:true,preferencesRestored:true,visitorArtifactsCleared:true,evidenceRefs:this.evidence('no-native-write-reset',identity,{runningPids:[]})};
    }
    const inspection = this.baseline.restore();
    const cleanup = this.baseline.finishRecovery();
    assertClosed();
    const evidenceRefs = this.evidence('native-reset-filesystem-readback',identity,{...inspection,...cleanup});
    this.baseline=undefined;this.session=undefined;this.runId=undefined;this.bindingDigest=undefined;this.sourceApp=undefined;
    return {targetClosed:true,preferencesRestored:inspection.preferencesRestored,visitorArtifactsCleared:inspection.visitorArtifactsCleared,evidenceRefs};
  }
}
