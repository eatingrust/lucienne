import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PlannerRequest, PlannerResult, RunEvent, SourceProfile, Target } from '../contracts/index.js';
import type { DesktopPort, NativeAdapter, NativeReadback, NativeResetResult, PlannerPort } from '../contracts/ports.js';
import type { RunCapture } from './audit.ts';
import type { EvidenceArtifact } from './artifacts.ts';
import type { TaskObservation } from './tasks.ts';

export interface CaptureClock { now(): number; iso(): string }
export type ResetAudit = Omit<NonNullable<RunCapture['reset']>, 'native' | 'desktop'>;
export interface CaptureOptions {
  outputRoot: string; buildId: string; source: SourceProfile; target: Target; scenarioId: string;
  evidenceKind: 'native' | 'fixture'; runId?: string; clockId?: string; clock?: CaptureClock;
}
const validId=(value:string)=>typeof value==='string'&&/^[A-Za-z0-9._:/-]{1,160}$/.test(value);
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
/** Observes real ports; never supplies fake readback, clocks, task results or reset
 * acknowledgments. Pass the returned clock/id/onEvent to host's coordinator. */
export class RunRecorder {
  readonly runId:string; readonly directory:string; readonly clockId:string; readonly clock:CaptureClock;
  private capture:RunCapture;
  private plans=new Map<string,{request:PlannerRequest;result:PlannerResult}>();
  private pendingReadbacks=new Map<string,RunCapture['commits'][number]>();
  private nativeReset?:NativeResetResult;
  private desktopReset?:{desktopVisible:boolean;evidenceRefs:string[]};
  private writes:Promise<void>=Promise.resolve();
  private writeFailure:unknown;
  private phase:'started'|'captured'|'incomplete'|'invalidated'='started';
  private hasFinalFile=false;
  private constructor(options:CaptureOptions) {
    this.runId=options.runId??`qa-${randomUUID()}`;
    this.directory=resolve(options.outputRoot,hash(this.runId).slice(0,20));
    this.clockId=options.clockId??`local:${randomUUID()}`;
    this.clock=options.clock??{now:()=>performance.now(),iso:()=>new Date().toISOString()};
    this.capture={version:1,buildId:options.buildId,clockId:this.clockId,runId:this.runId,
      scenarioId:options.scenarioId,capturedAt:this.clock.iso(),evidenceKind:options.evidenceKind,
      target:structuredClone(options.target),source:structuredClone(options.source),events:[],commits:[],tasks:[],artifacts:[]};
  }
  static async create(options:CaptureOptions):Promise<RunRecorder> {
    for(const value of [options.buildId,options.scenarioId,options.runId??'generated',options.clockId??'generated']) if(!validId(value))throw new Error('INVALID_CAPTURE_ID');
    if(!['native','fixture'].includes(options.evidenceKind))throw new Error('INVALID_EVIDENCE_KIND');
    const recorder=new RunRecorder(options);
    await mkdir(resolve(options.outputRoot),{recursive:true});
    // Exclusive per-attempt directory: an interrupted/failed run cannot inherit old passes.
    await mkdir(recorder.directory);
    await mkdir(resolve(recorder.directory,'artifacts'));
    recorder.checkpoint();await recorder.flush();return recorder;
  }
  private enqueue(write:()=>Promise<void>):Promise<void>{
    const operation=this.writes.then(write);
    this.writes=operation.catch(error=>{this.writeFailure=error;});return operation;
  }
  private checkpoint():void{
    this.capture.capturedAt=this.clock.iso();this.capture.captureStatus=this.phase;
    const snapshot=structuredClone(this.capture);const phase=this.phase;
    if(phase==='captured'||phase==='invalidated')this.hasFinalFile=true;
    const updateFinal=this.hasFinalFile;
    void this.enqueue(async()=>{
      const file=phase==='captured'||phase==='invalidated'?'capture.json':'capture.partial.json';
      await writeFile(resolve(this.directory,`${file}.tmp`),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
      await rename(resolve(this.directory,`${file}.tmp`),resolve(this.directory,file));
      if(updateFinal&&file!=='capture.json'){
        await writeFile(resolve(this.directory,'capture.json.tmp'),JSON.stringify(snapshot,null,2)+'\n',{mode:0o600});
        await rename(resolve(this.directory,'capture.json.tmp'),resolve(this.directory,'capture.json'));
      }
      await writeFile(resolve(this.directory,'attempt.json'),JSON.stringify({version:1,runId:this.runId,buildId:snapshot.buildId,
        scenarioId:snapshot.scenarioId,evidenceKind:snapshot.evidenceKind,phase,capturedAt:snapshot.capturedAt},null,2)+'\n',{mode:0o600});
    }).catch(()=>undefined);
  }
  async flush():Promise<void>{let tail:Promise<void>;do{tail=this.writes;await tail;}while(tail!==this.writes);if(this.writeFailure)throw new Error('CAPTURE_WRITE_FAILED');}
  /** Synchronous, nonblocking onEvent hook. Identity errors remain in the capture
   * for QA to reject; callback exceptions must not vanish inside core observers. */
  onEvent=(event:RunEvent):void=>{
    if(this.capture.events.length>=10000){this.writeFailure=new Error('TOO_MANY_CAPTURE_EVENTS');return;}
    if(this.phase==='captured')this.phase='invalidated';
    this.capture.events.push(structuredClone(event));
    if(event.type==='target-ready'||event.type==='chat-applied'){
      const receipt=event.requestId?this.pendingReadbacks.get(event.requestId):undefined;
      if(receipt)this.capture.commits.push(structuredClone(receipt));
    }
    this.checkpoint();
  };
  wrapPlanner(port:PlannerPort):PlannerPort{
    return {provider:port.provider,mode:port.mode,plan:async(request,context)=>{
      const result=await port.plan(request,context);
      this.plans.set(request.requestId,{request:structuredClone(request),result:structuredClone(result)});
      return result;
    }};
  }
  wrapAdapter(port:NativeAdapter):NativeAdapter{
    if(port.evidenceKind!==this.capture.evidenceKind||port.target.appId!==this.capture.target.appId||port.target.adapterVersion!==this.capture.target.adapterVersion)throw new Error('CAPTURE_ADAPTER_MISMATCH');
    return {target:port.target,evidenceKind:port.evidenceKind,catalog:port.catalog,
      apply:async(patch,request,context)=>port.apply(patch,request,context),
      readback:async(context)=>{
        const readback:NativeReadback=await port.readback(context);
        const planned=this.plans.get(context.requestId);
        if(planned)this.pendingReadbacks.set(context.requestId,{...structuredClone(planned),readback:structuredClone(readback),generation:context.generation});
        return readback;
      },
      reset:async(context)=>{const receipt=await port.reset(context);this.nativeReset=structuredClone(receipt);return receipt;},
    };
  }
  wrapDesktop(port:DesktopPort):DesktopPort{
    return {returnToDesktop:async()=>{const receipt=await port.returnToDesktop();this.desktopReset=structuredClone(receipt);return receipt;}};
  }
  /** Register adapter-owned evidence unchanged. Files must be under its explicit
   * evidence root. Unresolved refs remain unresolved; no receipt is invented. */
  async adoptArtifacts(artifacts:EvidenceArtifact[],sourceRoot:string):Promise<void>{
    const root=await realpath(sourceRoot);
    for(const a of artifacts){
      if(!validId(a.id)||a.runId!==this.runId||a.buildId!==this.capture.buildId||a.evidenceKind!==this.capture.evidenceKind)throw new Error('ARTIFACT_IDENTITY_MISMATCH');
      const source=await realpath(isAbsolute(a.path)?a.path:resolve(root,a.path));
      const rel=relative(root,source);
      if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('ARTIFACT_ROOT_ESCAPE');
      if((await stat(source)).size>16*1024*1024)throw new Error('ARTIFACT_TOO_LARGE');
      const bytes=await readFile(source);
      if(hash(bytes)!==a.sha256.toLowerCase())throw new Error('ARTIFACT_HASH_MISMATCH');
      await this.storeArtifact(a.id,bytes,extname(source));
    }
  }
  private async storeArtifact(id:string,bytes:Uint8Array,extension:string):Promise<string>{
    if(!validId(id)||bytes.byteLength>16*1024*1024)throw new Error('INVALID_CAPTURE_ARTIFACT');
    const sha256=hash(bytes);const old=this.capture.artifacts.find(a=>a.id===id);
    if(old){if(old.sha256!==sha256)throw new Error('ARTIFACT_REF_REUSED');return id;}
    const safeExtension=['.json','.png','.jpg','.jpeg','.txt'].includes(extension)?extension:'.bin';
    const path=`artifacts/${hash(id)}${safeExtension}`;
    await this.enqueue(()=>writeFile(resolve(this.directory,path),bytes,{mode:0o600,flag:'wx'}));
    this.capture.artifacts.push({id,path,sha256,buildId:this.capture.buildId,runId:this.runId,evidenceKind:this.capture.evidenceKind});
    this.checkpoint();return id;
  }
  /** Only supply independently observed native data; this writes no app state. */
  async writeObservation(id:string,observation:unknown):Promise<string>{
    const bytes=Buffer.from(JSON.stringify({runId:this.runId,buildId:this.capture.buildId,evidenceKind:this.capture.evidenceKind,
      observedAt:this.clock.iso(),observation},null,2)+'\n');
    return this.storeArtifact(id,bytes,'.json');
  }
  recordTask(observation:TaskObservation):void{this.capture.tasks.push(structuredClone(observation));this.checkpoint();}
  recordResetAudit(observation:ResetAudit):void{
    if(!this.nativeReset||!this.desktopReset)throw new Error('RESET_RECEIPTS_MISSING');
    this.capture.reset={...structuredClone(observation),native:structuredClone(this.nativeReset),desktop:structuredClone(this.desktopReset)};this.checkpoint();
  }
  recordRelaunch(observation:NonNullable<RunCapture['relaunch']>):void{this.capture.relaunch=structuredClone(observation);this.checkpoint();}
  latestCommittedIdentity():{runId:string;requestId:string;generation:number}{
    const commit=this.capture.commits.at(-1);if(!commit)throw new Error('COMMITTED_READBACK_MISSING');
    return {runId:this.runId,requestId:commit.request.requestId,generation:commit.generation};
  }
  snapshot():RunCapture{return structuredClone(this.capture);}
  /** Captured means saved, not passed. Missing task/reset/evidence fields remain
   * blocked in auditCapture; a later event invalidates and updates this file. */
  async finish():Promise<string>{if(this.phase==='invalidated')throw new Error('CAPTURE_INVALIDATED');this.phase='captured';this.checkpoint();await this.flush();return resolve(this.directory,'capture.json');}
  async markIncomplete():Promise<string>{this.phase='incomplete';this.checkpoint();await this.flush();return resolve(this.directory,'capture.partial.json');}
}
