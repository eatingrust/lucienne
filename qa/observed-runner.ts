import { isDeepStrictEqual } from 'node:util';
import type { Capability, ChatIntent, NativePatch, Operation, PlannerRequest, PlannerResult, RunEvent } from '../contracts/index.js';
import type { CommitContext, DesktopPort, NativeAdapter, NativeReadback, PlannerPort } from '../contracts/ports.js';
import type { Selection } from '../core/session.js';
import type { EvidenceArtifact } from './artifacts.ts';
import type { RunCapture } from './audit.ts';
import { RunRecorder, type CaptureClock, type ResetAudit } from './capture.ts';
import type { TaskObservation } from './tasks.ts';

type MaybePromise<T> = T | Promise<T>;
export type ObservedIdentity = {runId:string;requestId:string;generation:number};
export interface ObservedQAState { evidenceRefs: string[] }
export interface ObservedQAAdapter<Observation extends ObservedQAState> extends NativeAdapter {
  observe(identity:ObservedIdentity):Promise<Observation>;
  isQuiescent():MaybePromise<boolean>;
  getEvidenceArtifacts():MaybePromise<EvidenceArtifact[]>;
}
export interface ObservedQARuntime<Action extends string, Observation extends ObservedQAState> {
  adapter:ObservedQAAdapter<Observation>;
  desktop:DesktopPort;
  initialPlanner:PlannerPort;
  chatPlanner:PlannerPort;
  /** The serialized desktop owner performs the gesture and settles any native
   * work before returning, including after abort. The runner invents no task state. */
  performTask(action:Action,instruction:string,context?:{signal:AbortSignal}):Promise<void>;
  onEvent?(event:RunEvent):void;
  onSnapshot?(snapshot:QASnapshot):void;
  inspectReset():Promise<ResetAudit>;
  /** Must settle its launch and clean it up on abort/failure. The prior session's
   * completed reset cannot close a new process launched after the session is idle. */
  ordinaryRelaunch(context?:{signal:AbortSignal}):Promise<NonNullable<RunCapture['relaunch']>>;
  evidenceRoot:string;
  getEvidenceArtifacts?():MaybePromise<EvidenceArtifact[]>;
}
export interface QASnapshot {phase:string;remainingMs:number;runId:string|null;closingRemainingMs?:number;busy?:boolean;lastError?:string|null}
export interface QACoordinator {
  select(selection:Selection,adapter:NativeAdapter):unknown;
  translate(planner:PlannerPort):Promise<void>;
  openChat():void;
  chat(planner:PlannerPort,input:{intent:ChatIntent;instruction:string;explicit?:PlannerRequest['explicit']}):Promise<void>;
  tick():void;
  snapshot():QASnapshot;
  subscribe?(listener:(snapshot:QASnapshot)=>void):()=>void;
  reset(reason?:string):Promise<void>;
}
export interface RunnerScheduler {
  wait(ms:number):Promise<void>;
  setTimeout(callback:()=>void,ms:number):unknown;
  clearTimeout(handle:unknown):void;
}
export interface ObservedTaskValidation {
  status:'pass'|'fail'|'blocked';
  observation?:TaskObservation;
}
export interface ObservedChatRecipe {
  intent:ChatIntent;
  instruction:string;
  explicit?:PlannerRequest['explicit'];
  expectedOperation:Operation;
}
export interface ObservedRunOptions<Action extends string, Observation extends ObservedQAState> {
  /** Original trusted host selection, including its host policy and evidence. */
  selection:Selection;
  buildId:string;outputRoot:string;runtime:ObservedQARuntime<Action,Observation>;
  tasks:readonly (readonly [Action,string])[];
  validateTask(action:Action,before:Observation,after:Observation,evidenceRefs:string[]):ObservedTaskValidation;
  chatRecipe(intent:ChatIntent,currentOperations:readonly Operation[],catalog:readonly Capability[]):ObservedChatRecipe;
  createCoordinator(options:{desktop:DesktopPort;clock:CaptureClock;id:()=>string;onEvent:(event:RunEvent)=>void}):QACoordinator;
  clock?:CaptureClock;scheduler?:RunnerScheduler;runId?:string;clockId?:string;
  maxRunMs?:number;pollMs?:number;signal?:AbortSignal;onStage?:(stage:string)=>void;
  verifyCommit?(recorder:RunRecorder):Promise<void>;
  verifyObservation?(recorder:RunRecorder,identity:ObservedIdentity,raw:Observation):Promise<void>;
  verifyCapture?(recorder:RunRecorder):Promise<void>;
}
export interface ObservedRunResult {
  status:'captured'|'incomplete';capturePath:string;runId:string;stage:string;
  errorCode?:string;cleanupErrors:string[];
}
const defaultScheduler:RunnerScheduler={
  wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  setTimeout:(callback,ms)=>setTimeout(callback,ms),
  clearTimeout:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const codeOf=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)?error.message:'QA_STAGE_FAILED';
function fail(code:string):never{throw new Error(code);}
/** One bounded observed native attempt. `captured` means
 * saved, never passed. Use the shared audit/CLI to evaluate the evidence.
 *
 * The deadline requests reset; it is not permission to release an unresolved
 * native writer. External gesture callbacks are awaited before reset, and adapter
 * quiescence is awaited before inspection/relaunch. A hung writer intentionally
 * holds this function and the desktop slot until its owner can settle it.
 */
export async function runObservedQA<Action extends string, Observation extends ObservedQAState>(options:ObservedRunOptions<Action,Observation>):Promise<ObservedRunResult>{
  const {runtime}=options;
  const selection=structuredClone(options.selection);
  const target=structuredClone(runtime.adapter.target);
  const catalog=structuredClone([...runtime.adapter.catalog]);
  const evidenceKind=runtime.adapter.evidenceKind;
  const requiredRequestRefs=new Set([
    ...(selection.evidenceRefs??selection.source.evidenceRefs),
    ...(selection.bindingApplicability?.entries.flatMap(entry=>entry.evidenceRefs)??[]),
  ]);
  if(!isDeepStrictEqual(selection.target,target))fail('QA_SELECTION_TARGET_MISMATCH');
  const maxRunMs=options.maxRunMs??300_000,pollMs=options.pollMs??100;
  if(!Number.isFinite(maxRunMs)||maxRunMs<=0||maxRunMs>300_000||!Number.isFinite(pollMs)||pollMs<=0||pollMs>1000) fail('INVALID_RUN_BOUNDS');
  const scheduler=options.scheduler??defaultScheduler;
  const recorder=await RunRecorder.create({outputRoot:options.outputRoot,buildId:options.buildId,source:selection.source,
    target,scenarioId:selection.scenarioId,evidenceKind,
    runId:options.runId,clockId:options.clockId,clock:options.clock});
  let coordinator:QACoordinator|undefined;
  let resetPromise:Promise<void>|undefined;
  let externalGesture=false;
  const taskController=new AbortController();
  let unsubscribe:(()=>void)|undefined;
  let stopCode:string|undefined;
  let stage='created';
  let errorCode:string|undefined;
  const cleanupErrors:string[]=[];
  const setStage=(value:string)=>{stage=value;try{options.onStage?.(value);}catch{/* UI observers cannot own lifecycle. */}};
  const holdResetPromise=(promise:Promise<void>)=>{resetPromise=promise;void promise.catch(()=>undefined);return promise;};
  const requestReset=(reason:string):Promise<void>=>{
    if(resetPromise)return resetPromise;
    if(!coordinator)return Promise.resolve();
    return holdResetPromise(coordinator.reset(reason));
  };
  const stop=(code:string)=>{
    if(!stopCode){
      stopCode=code;
      void recorder.writeObservation(`qa:${recorder.runId}:stop-request`,{stage,code})
        .then(()=>recorder.markIncomplete()).catch(()=>undefined);
    }
    if(!taskController.signal.aborted)taskController.abort(new Error(code));
    // A caller-owned native gesture is outside the core lane. Do not race it.
    if(!externalGesture&&coordinator)void requestReset(code).catch(()=>undefined);
  };
  const assertActive=()=>{if(stopCode)fail(stopCode);};
  // Pin trusted selection and request content before calling either planner or
  // adapter. IDs alone cannot detect source/policy mutation under one revision.
  let generation:number|undefined;
  let resetting=false;
  let planningIdentity:ObservedIdentity|undefined;
  const requests=new Map<string,{request:PlannerRequest;generation:number;result?:PlannerResult;applied?:boolean;readback?:NativeReadback;committed?:boolean}>();
  const assertAdapterScope=()=>{
    if(!isDeepStrictEqual(runtime.adapter.target,target)||!isDeepStrictEqual([...runtime.adapter.catalog],catalog)
      ||runtime.adapter.evidenceKind!==evidenceKind)fail('QA_ADAPTER_SCOPE_CHANGED');
  };
  const assertRequestScope=(request:PlannerRequest)=>{
    assertAdapterScope();
    if(request.runId!==recorder.runId||request.scenarioId!==selection.scenarioId
      ||!isDeepStrictEqual(request.target,target)||!isDeepStrictEqual(request.source,selection.source)
      ||!isDeepStrictEqual(request.catalog,catalog)
      ||!isDeepStrictEqual(request.bindingApplicability,selection.bindingApplicability)
      // Initial trusted preparation can append request-only evidence. Chat may
      // omit that enrichment, but cannot drop selection or policy evidence.
      ||[...requiredRequestRefs].some(ref=>!request.evidenceRefs.includes(ref)))fail('QA_REQUEST_SCOPE_MISMATCH');
  };
  const assertPatchScope=(patch:NativePatch,request:PlannerRequest)=>{
    if(patch.runId!==request.runId||patch.requestId!==request.requestId||patch.scenarioId!==request.scenarioId
      ||!isDeepStrictEqual(patch.target,target))fail('QA_PATCH_IDENTITY_MISMATCH');
  };
  const assertContext=(context:CommitContext)=>{
    const entry=requests.get(context.requestId);
    if(!entry||context.runId!==recorder.runId||context.generation!==entry.generation||context.generation!==generation
      ||resetting||context.signal.aborted||!context.isCurrent())fail('QA_COMMIT_IDENTITY_MISMATCH');
    assertAdapterScope();return entry;
  };
  const guardPlanner=(port:PlannerPort):PlannerPort=>{
    const provider=port.provider,mode=port.mode;
    return {provider,mode,plan:async(request,context)=>{
      assertActive();assertRequestScope(request);
      if(!planningIdentity||planningIdentity.requestId!==request.requestId||planningIdentity.runId!==request.runId
        ||planningIdentity.generation!==generation||resetting||context.signal.aborted||requests.has(request.requestId))fail('QA_PLAN_IDENTITY_MISMATCH');
      // host retains the committed patch order; native readback may report the
      // same complete operation set in a different order.
      const previous=recorder.snapshot().commits.at(-1)?.result.patch.operations??[];
      if(!isDeepStrictEqual(request.currentOperations,previous))fail('QA_CURRENT_OPERATIONS_MISMATCH');
      const entry:{request:PlannerRequest;generation:number;result?:PlannerResult}={request:structuredClone(request),generation:planningIdentity.generation};
      requests.set(request.requestId,entry);
      const result=await port.plan(request,context);
      assertRequestScope(request);
      if(!isDeepStrictEqual(request,entry.request))fail('QA_PLANNER_REQUEST_MUTATED');
      if(context.signal.aborted||resetting||generation!==entry.generation)fail('QA_PLAN_IDENTITY_MISMATCH');
      assertPatchScope(result.patch,entry.request);
      if(result.provenance.provider!==provider||result.provenance.mode!==mode)fail('QA_PLANNER_PROVENANCE_MISMATCH');
      entry.result=structuredClone(result);return result;
    }};
  };
  const guardedAdapter:NativeAdapter={target:structuredClone(target),catalog:structuredClone(catalog),evidenceKind,
    apply:async(patch,request,context)=>{
      const entry=assertContext(context);assertRequestScope(request);assertPatchScope(patch,request);
      if(!isDeepStrictEqual(request,entry.request)||!entry.result||!isDeepStrictEqual(patch,entry.result.patch)
        ||entry.applied)fail('QA_APPLY_SCOPE_MISMATCH');
      // No timeout race here: even an aborted native writer must settle first.
      await runtime.adapter.apply(patch,request,context);
      assertContext(context);assertRequestScope(request);
      if(!isDeepStrictEqual(request,entry.request)||!isDeepStrictEqual(patch,entry.result.patch))fail('QA_ADAPTER_INPUT_MUTATED');
      entry.applied=true;
    },
    readback:async context=>{
      const entry=assertContext(context);
      if(!entry.applied||entry.readback)fail('QA_READBACK_ORDER_MISMATCH');
      const readback=await runtime.adapter.readback(context);
      assertContext(context);
      if(readback.requestId!==context.requestId)fail('QA_READBACK_IDENTITY_MISMATCH');
      entry.readback=structuredClone(readback);return readback;
    },
    reset:async context=>{
      // Report bad identity without withholding restoration of partial writes.
      if(context.runId!==recorder.runId||context.generation!==generation||!resetting)stop('QA_RESET_IDENTITY_MISMATCH');
      return runtime.adapter.reset(context);
    },
  };
  const inspectEvent=(event:RunEvent)=>{
    if(event.runId!==recorder.runId||event.scenarioId!==selection.scenarioId||!isDeepStrictEqual(event.target,target)
      ||event.evidenceKind!==evidenceKind||!Number.isInteger(event.generation)||event.generation<1)fail('QA_EVENT_IDENTITY_MISMATCH');
    if(event.type==='selected'){
      if(generation!==undefined)fail('QA_EVENT_IDENTITY_MISMATCH');
      generation=event.generation;
    }else if(event.type==='reset-started'){
      if(generation===undefined||resetting||event.generation!==generation+1)fail('QA_EVENT_IDENTITY_MISMATCH');
      generation=event.generation;resetting=true;
    }else if(event.generation!==generation)fail('QA_EVENT_IDENTITY_MISMATCH');
    if(event.type==='planning'){
      if(resetting||!event.requestId)fail('QA_EVENT_IDENTITY_MISMATCH');
      planningIdentity={runId:event.runId,requestId:event.requestId,generation:event.generation};
    }
    if(event.type==='target-ready'||event.type==='chat-applied'){
      const entry=event.requestId?requests.get(event.requestId):undefined;
      if(resetting||!entry?.readback||!entry.result||entry.committed||entry.generation!==event.generation
        ||event.requestId!==planningIdentity?.requestId
        ||entry.request.kind!==(event.type==='target-ready'?'translate':'chat')
        ||event.provider!==entry.result.provenance.provider||event.mode!==entry.result.provenance.mode
        ||!isDeepStrictEqual(event.evidenceRefs,[...new Set(entry.readback.evidenceRefs)].slice(0,32)))fail('QA_EVENT_IDENTITY_MISMATCH');
      entry.committed=true;
    }
  };
  const assertObservationIdentity=(identity:ObservedIdentity)=>{
    assertActive();assertAdapterScope();
    if(resetting||identity.generation!==generation||!isDeepStrictEqual(identity,recorder.latestCommittedIdentity()))fail('QA_OBSERVATION_IDENTITY_MISMATCH');
  };
  const abort=()=>stop('QA_ABORTED');
  const awaitQuiescence=async()=>{
    for(;;){
      try{if(await runtime.adapter.isQuiescent()===true)return;}
      catch{
        if(!cleanupErrors.includes('QUIESCENCE_CHECK_FAILED')){
          cleanupErrors.push('QUIESCENCE_CHECK_FAILED');errorCode??='QUIESCENCE_CHECK_FAILED';
          try{await recorder.writeObservation(`qa:${recorder.runId}:quiescence-error`,{stage,errorCode});await recorder.markIncomplete();}
          catch(error){cleanupErrors.push(codeOf(error));}
        }
      }
      // Unknown quiescence is not a release signal. A stalled/failed observer
      // keeps the desktop held until it can affirm settlement.
      await scheduler.wait(pollMs);
    }
  };
  let watchdog:unknown;
  let tickTimer:unknown;
  let pumpActive=false;
  const publishSnapshot=()=>{if(coordinator)try{runtime.onSnapshot?.(coordinator.snapshot());}catch{stop('RUNTIME_SNAPSHOT_OBSERVER_FAILED');}};
  const tickSafely=()=>{
    if(!coordinator)return;
    if(externalGesture&&coordinator.snapshot().phase==='closing'){
      stop('TASK_WINDOW_EXPIRED');publishSnapshot();return;
    }
    coordinator.tick();publishSnapshot();
  };
  const scheduleTick=()=>{
    tickTimer=scheduler.setTimeout(()=>{
      if(!pumpActive)return;
      try{tickSafely();}catch{stop('COORDINATOR_TICK_FAILED');}
      if(pumpActive)scheduleTick();
    },pollMs);
  };
  try{
    coordinator=options.createCoordinator({desktop:recorder.wrapDesktop(runtime.desktop),clock:recorder.clock,id:()=>recorder.runId,
      onEvent:event=>{
        recorder.onEvent(event);
        try{inspectEvent(event);}catch(error){stop(codeOf(error));}
        try{runtime.onEvent?.(event);}catch{stop('RUNTIME_EVENT_OBSERVER_FAILED');}
        // host assigns its idempotent reset promise before emitting reset-started.
        // Observe that same attempt so automatic-reset errors cannot disappear.
        if(event.type==='reset-started'&&coordinator&&!resetPromise)holdResetPromise(coordinator.reset('QA_OBSERVE_RESET'));
        if(event.type==='closing'&&externalGesture)stop('TASK_WINDOW_EXPIRED');
        if(event.type==='reset-started'&&externalGesture)stop('QA_SESSION_RESET_DURING_TASK');
      }});
    if(runtime.onSnapshot){
      const publish=(snapshot:QASnapshot)=>{try{runtime.onSnapshot?.(snapshot);}catch{stop('RUNTIME_SNAPSHOT_OBSERVER_FAILED');}};
      unsubscribe=coordinator.subscribe?.(publish);publish(coordinator.snapshot());
    }
    options.signal?.addEventListener('abort',abort,{once:true});
    watchdog=scheduler.setTimeout(()=>stop('QA_RUN_TIMEOUT'),maxRunMs);
    pumpActive=true;scheduleTick();
    if(options.signal?.aborted)stop('QA_ABORTED');
    assertActive();
    setStage('translate');
    coordinator.select(structuredClone(selection),recorder.wrapAdapter(guardedAdapter));
    await coordinator.translate(recorder.wrapPlanner(guardPlanner(runtime.initialPlanner)));
    assertActive();
    if(coordinator.snapshot().phase!=='ready')fail('TARGET_NOT_READY');
    await options.verifyCommit?.(recorder);assertActive();
    for(const [action,instruction] of options.tasks){
      setStage(`task-${action}`);assertActive();tickSafely();
      if(coordinator.snapshot().phase!=='ready')fail('TASK_WINDOW_EXPIRED');
      const identity=recorder.latestCommittedIdentity();
      assertObservationIdentity(identity);
      const before=structuredClone(await runtime.adapter.observe(structuredClone(identity)));assertObservationIdentity(identity);
      await options.verifyObservation?.(recorder,structuredClone(identity),structuredClone(before));assertObservationIdentity(identity);
      const beforeRef=await recorder.writeObservation(`qa:${recorder.runId}:${action}:before`,before);
      assertActive();tickSafely();
      if(coordinator.snapshot().phase!=='ready')fail('TASK_WINDOW_EXPIRED');
      externalGesture=true;
      try{await runtime.performTask(action,instruction,{signal:taskController.signal});}finally{externalGesture=false;}
      assertActive();
      assertObservationIdentity(identity);
      const after=structuredClone(await runtime.adapter.observe(structuredClone(identity)));assertObservationIdentity(identity);
      await options.verifyObservation?.(recorder,structuredClone(identity),structuredClone(after));assertObservationIdentity(identity);
      const afterRef=await recorder.writeObservation(`qa:${recorder.runId}:${action}:after`,after);
      const evidenceRefs=[...new Set([...before.evidenceRefs,...after.evidenceRefs,beforeRef,afterRef])];
      const checked=options.validateTask(action,before,after,evidenceRefs);
      await recorder.writeObservation(`qa:${recorder.runId}:${action}:validation`,checked);
      if(checked.observation)recorder.recordTask(checked.observation);
      if(checked.status!=='pass')fail(checked.status==='fail'?'NATIVE_TASK_FAILED':'NATIVE_TASK_UNVERIFIED');
    }
    setStage('late-chat-countdown');
    // Exercise the existing 30-second extension with a genuine changed chat.
    while(coordinator.snapshot().remainingMs>25_000){
      assertActive();tickSafely();
      if(coordinator.snapshot().phase!=='ready')fail('CHAT_WINDOW_EXPIRED');
      await scheduler.wait(Math.min(pollMs,coordinator.snapshot().remainingMs-25_000));
    }
    for(const intent of ['move-key-panels','enlarge-work-area','simplify-tools'] as const){
      setStage(`chat-${intent}`);assertActive();tickSafely();
      if(coordinator.snapshot().phase!=='ready'||coordinator.snapshot().remainingMs<=0)fail('CHAT_WINDOW_EXPIRED');
      const currentOperations=recorder.snapshot().commits.at(-1)?.readback.operations;
      if(!currentOperations)fail('COMMITTED_READBACK_MISSING');
      const chat=options.chatRecipe(intent,structuredClone(currentOperations),structuredClone(catalog));
      if(chat.intent!==intent)fail('QA_CHAT_INTENT_MISMATCH');
      const capability=catalog.find(cap=>cap.id===chat.expectedOperation.capabilityId);
      const prior=currentOperations.find(op=>op.capabilityId===capability?.id);
      const allowedKinds=intent==='move-key-panels'?['layout']:intent==='enlarge-work-area'?['canvas','timeline']:['tool-layout'];
      if(!capability||!allowedKinds.includes(capability.kind)||!capability.values.includes(chat.expectedOperation.value)||!prior)fail('CHAT_CAPABILITY_UNAVAILABLE');
      if(prior.value===chat.expectedOperation.value)fail('CHAT_WOULD_BE_NOOP');
      coordinator.openChat();
      await coordinator.chat(recorder.wrapPlanner(guardPlanner(runtime.chatPlanner)),{intent:chat.intent,instruction:chat.instruction,...(chat.explicit?{explicit:chat.explicit}:{})});
      assertActive();
      const after=recorder.snapshot().commits.at(-1)?.readback.operations.find(op=>op.capabilityId===capability.id);
      if(coordinator.snapshot().phase!=='ready'||after?.value!==chat.expectedOperation.value)fail('CHAT_CHANGE_UNVERIFIED');
      await options.verifyCommit?.(recorder);assertActive();
    }
    setStage('automatic-reset-countdown');
    while(coordinator.snapshot().phase!=='idle'){
      assertActive();tickSafely();
      if(coordinator.snapshot().phase==='error'){if(resetPromise)await resetPromise;fail('AUTOMATIC_RESET_FAILED');}
      if(coordinator.snapshot().phase!=='idle')await scheduler.wait(pollMs);
    }
    if(resetPromise)await resetPromise;
    if(!recorder.snapshot().events.some(event=>event.type==='reset-completed'))fail('AUTOMATIC_RESET_UNVERIFIED');
    setStage('await-quiescence');
    await awaitQuiescence();
    if(errorCode)fail(errorCode);
    assertActive();
    setStage('reset-inspection');
    const reset=await runtime.inspectReset();assertActive();
    const resetRef=await recorder.writeObservation(`qa:${recorder.runId}:reset-inspection`,reset);
    recorder.recordResetAudit({...reset,evidenceRefs:[...new Set([...reset.evidenceRefs,resetRef])]});
    if(!reset.baselineCompared||!reset.visitorStateCleared||!reset.recentsCleared||reset.lateWritesObserved)fail('RESET_AUDIT_FAILED');
    setStage('ordinary-relaunch');
    externalGesture=true;
    let relaunch:NonNullable<RunCapture['relaunch']>;
    try{relaunch=await runtime.ordinaryRelaunch({signal:taskController.signal});}finally{externalGesture=false;}
    assertActive();
    const relaunchRef=await recorder.writeObservation(`qa:${recorder.runId}:ordinary-relaunch`,relaunch);
    recorder.recordRelaunch({...relaunch,evidenceRefs:[...new Set([...relaunch.evidenceRefs,relaunchRef])]});
    if(!relaunch.targetVisible||!relaunch.interactive||!relaunch.baselineCompared||!relaunch.visitorStateAbsent)fail('RELAUNCH_UNVERIFIED');
  }catch(error){errorCode=stopCode??codeOf(error);}
  finally{
    pumpActive=false;
    if(tickTimer!==undefined)scheduler.clearTimeout(tickTimer);
    if(watchdog!==undefined)scheduler.clearTimeout(watchdog);
    options.signal?.removeEventListener('abort',abort);
    try{unsubscribe?.();}catch{cleanupErrors.push('SNAPSHOT_UNSUBSCRIBE_FAILED');}
    // No automatic retry and no timed release: settle the existing reset attempt.
    if(errorCode){
      try{
        await recorder.writeObservation(`qa:${recorder.runId}:failure-start`,{stage,errorCode});
        await recorder.markIncomplete();
      }catch(error){cleanupErrors.push(codeOf(error));}
      try{await requestReset(errorCode);}catch(error){cleanupErrors.push(codeOf(error));}
      await awaitQuiescence();
      try{await recorder.writeObservation(`qa:${recorder.runId}:failure`,{stage,errorCode,cleanupErrors});}catch(error){cleanupErrors.push(codeOf(error));}
    }
    try{
      await recorder.adoptArtifacts(await runtime.adapter.getEvidenceArtifacts(),runtime.evidenceRoot);
      if(runtime.getEvidenceArtifacts)await recorder.adoptArtifacts(await runtime.getEvidenceArtifacts(),runtime.evidenceRoot);
      await options.verifyCapture?.(recorder);
    }catch(error){cleanupErrors.push(codeOf(error));errorCode??=codeOf(error);}
    if(errorCode)try{await recorder.writeObservation(`qa:${recorder.runId}:failure-final`,{stage,errorCode,cleanupErrors});}
      catch(error){cleanupErrors.push(codeOf(error));}
  }
  const status=errorCode||cleanupErrors.length?'incomplete':'captured';
  const capturePath=status==='captured'?await recorder.finish():await recorder.markIncomplete();
  return {status,capturePath,runId:recorder.runId,stage,...(errorCode?{errorCode}:{}),cleanupErrors};
}
