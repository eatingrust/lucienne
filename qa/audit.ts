import type { BindingRequirementContext, BindingRequirements, PlannerRequest, PlannerResult, QAResult, RunEvent, SourceProfile, Target } from '../contracts/index.js';
import type { NativeReadback, NativeResetResult } from '../contracts/ports.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { chatIntents, routes, taskActions } from './matrix.ts';
import { checkTask, type Finding, type TaskObservation } from './tasks.ts';
import { auditLifecycle } from './lifecycle.ts';
import { validateNativeTask } from './native-checks.ts';
import type { ArtifactCheck, EvidenceArtifact } from './artifacts.ts';

/** QA-only capture sidecar. Product objects inside it use host contracts verbatim.
 * The observer writes independent readbacks and binds evidence bytes to this build/run.
 * Hashes establish integrity, not observer authenticity; live review remains necessary. */
export interface RunCapture {
  captureStatus?: 'started' | 'captured' | 'incomplete' | 'invalidated';
  version: 1; buildId: string; clockId: string; runId: string; scenarioId: string;
  capturedAt: string; evidenceKind: 'native' | 'fixture'; target: Target; source: SourceProfile;
  events: RunEvent[];
  commits: {request: PlannerRequest; result: PlannerResult; readback: NativeReadback; generation: number}[];
  tasks: TaskObservation[];
  reset?: { native: NativeResetResult; desktop: {desktopVisible: boolean; evidenceRefs: string[]};
    baselineCompared: boolean; visitorStateCleared: boolean; recentsCleared: boolean;
    lateWritesObserved: boolean; evidenceRefs: string[] };
  relaunch?: { targetVisible: boolean; interactive: boolean; baselineCompared: boolean;
    visitorStateAbsent: boolean; evidenceRefs: string[] };
  artifacts: EvidenceArtifact[];
}
interface Parser<T> { parse(input: unknown): T }
export interface SharedContracts {
  RunEventSchema: Parser<RunEvent>; SourceProfileSchema: Parser<SourceProfile>;
  PlannerResultSchema: Parser<PlannerResult>; QAResultSchema: Parser<QAResult>;
  validateRequest(input: unknown): PlannerRequest;
  validatePatch(input: unknown, request: PlannerRequest): PlannerResult['patch'];
  resolveBindingRequirements?(context: BindingRequirementContext): BindingRequirements;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,160}$/.test(value);
const boundedArray = (value: unknown, limit: number): value is unknown[] => Array.isArray(value) && value.length <= limit && [...value].every(item => item !== undefined);
const refs = (value: unknown): value is string[] => boundedArray(value,32) && value.every(id);
const booleans = (value: Record<string, unknown>, fields: string[]) => fields.every(field => typeof value[field] === 'boolean');
// Bound observer projections before semantic task assertions inspect them. They
// are local QA records, not additional product/native adapter schemas.
function boundedState(value: unknown): boolean {
  let budget = 20_000;
  const visit = (item: unknown, depth: number): boolean => {
    if (--budget < 0 || depth > 6) return false;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 2048;
    if (typeof item === 'boolean' || item === null) return true;
    if (Array.isArray(item)) return item.length <= 10_000 && [...item].every(child => visit(child,depth+1));
    return record(item) && Object.keys(item).length <= 10_000 && Object.entries(item).every(([key,child]) => key.length <= 160 && visit(child,depth+1));
  };
  return record(value) && Object.keys(value).length <= 32 && visit(value,0);
}
export function parseCapture(input: unknown, contracts: SharedContracts): RunCapture {
  if (!record(input) || input.version !== 1 || !id(input.buildId) || !id(input.clockId) ||
      !id(input.runId) || !id(input.scenarioId) || typeof input.capturedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(input.capturedAt) || !Number.isFinite(Date.parse(input.capturedAt)) ||
      typeof input.evidenceKind !== 'string' || !['native','fixture'].includes(input.evidenceKind) || !boundedArray(input.events,10_000) ||
      !boundedArray(input.commits,128) || !boundedArray(input.tasks,64) || !boundedArray(input.artifacts,1024) ||
      !record(input.target) || !id(input.target.adapterVersion)) throw new Error('INVALID_QA_CAPTURE');
  if (input.captureStatus !== undefined && !['started','captured','incomplete','invalidated'].includes(input.captureStatus as string)) throw new Error('INVALID_CAPTURE_STATUS');
  const c = structuredClone(input) as unknown as RunCapture;
  c.source = contracts.SourceProfileSchema.parse(c.source);
  if (!routes.some(r => r.source === c.source.sourceApp && r.target === c.target?.appId) || !c.target.adapterVersion) throw new Error('INVALID_CAPTURE_ROUTE');
  c.events = c.events.map(e => contracts.RunEventSchema.parse(e));
  c.commits = c.commits.map(commit => {
    if (!record(commit)) throw new Error('INVALID_CAPTURE_COMMIT');
    const request = contracts.validateRequest(commit.request);
    const result = contracts.PlannerResultSchema.parse(commit.result);
    contracts.validatePatch(result.patch,request);
    if (!Number.isSafeInteger(commit.generation) || commit.generation < 1 || !record(commit.readback) ||
        !id(commit.readback.requestId) || !booleans(commit.readback,['targetVisible','interactive']) ||
        !boundedArray(commit.readback.operations,64) || !commit.readback.operations.every(op => record(op) && id(op.capabilityId) &&
          typeof op.value === 'string' && op.value.length > 0 && op.value.length <= 160) || !refs(commit.readback.evidenceRefs)) throw new Error('INVALID_CAPTURE_READBACK');
    return {...commit,request,result};
  });
  for (const task of c.tasks) if (!record(task) || !id(task.action) || !boundedState(task.before) || !boundedState(task.after) || !refs(task.evidenceRefs)) throw new Error('INVALID_CAPTURE_TASK');
  for (const artifact of c.artifacts) if (!record(artifact) || !id(artifact.id) || !id(artifact.buildId) || !id(artifact.runId) ||
    typeof artifact.path !== 'string' || !artifact.path.length || artifact.path.length > 2048 ||
    typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256) || !['native','fixture'].includes(artifact.evidenceKind)) throw new Error('INVALID_CAPTURE_ARTIFACT');
  if (c.reset !== undefined && (!record(c.reset) || !record(c.reset.native) || !record(c.reset.desktop) ||
    !booleans(c.reset,['baselineCompared','visitorStateCleared','recentsCleared','lateWritesObserved']) || !refs(c.reset.evidenceRefs) ||
    !booleans(c.reset.native,['targetClosed','preferencesRestored','visitorArtifactsCleared']) || !refs(c.reset.native.evidenceRefs) ||
    !booleans(c.reset.desktop,['desktopVisible']) || !refs(c.reset.desktop.evidenceRefs))) throw new Error('INVALID_CAPTURE_RESET');
  if (c.relaunch !== undefined && (!record(c.relaunch) || !booleans(c.relaunch,['targetVisible','interactive','baselineCompared','visitorStateAbsent']) || !refs(c.relaunch.evidenceRefs))) throw new Error('INVALID_CAPTURE_RELAUNCH');
  return c;
}
export interface RunAudit { buildId: string; runId: string; scenarioId: string; sourceApp: string; personaId: string; profileRevision: string;
  target: Target; evidenceKind: 'native' | 'fixture'; mode: string;
  liveNativePass: boolean; findings: Finding[]; results: QAResult[];
  /** Exact declared limitations from host's resolver; never proof of visible UI. */
  bindingLimitations?: string[] }
const equalOperations = (a: NativeReadback['operations'], b: NativeReadback['operations']) =>
  new Set(a.map(o=>o.capabilityId)).size === a.length && a.length === b.length &&
  b.every(expected => a.some(actual=> actual.capabilityId === expected.capabilityId && actual.value === expected.value));
export function auditCapture(c: RunCapture, artifacts: ArtifactCheck[], contracts?: Pick<SharedContracts,'resolveBindingRequirements'>): RunAudit {
  const findings: Finding[] = [];
  const add = (id: string,status: Finding['status'],detail: string) => findings.push({id,status,detail});
  if(c.captureStatus!==undefined && c.captureStatus!=='captured') add('collection',c.captureStatus==='invalidated'?'fail':'blocked','Capture collection is not complete; saved observations are not a completed run');
  const byId = new Map(c.artifacts.map(a=>[a.id,a]));
  const checkCounts = new Map<string,number>();
  artifacts.forEach(a=>checkCounts.set(a.id,(checkCounts.get(a.id)??0)+1));
  // ArtifactCheck is a trusted local verifier result, not a signature. Caller must
  // run verifyArtifacts on this exact capture; no function can authenticate a
  // manifest whose author fabricates native claims and all accompanying bytes.
  const verified = new Set(artifacts.filter(a=>a.status === 'pass'&&checkCounts.get(a.id)===1&&byId.has(a.id)).map(a=>a.id));
  if (byId.size !== c.artifacts.length) add('evidence.manifest','fail','Artifact IDs are duplicated');
  for (const a of c.artifacts) {
    if (a.buildId !== c.buildId || a.runId !== c.runId || a.evidenceKind !== c.evidenceKind) add(`evidence.${a.id}`,'fail','Artifact build/run/kind must match the capture');
    if (!checkCounts.has(a.id)) add(`evidence.${a.id}`,'blocked','Artifact has no local verification result');
  }
  artifacts.filter(a=>!byId.has(a.id)||checkCounts.get(a.id)!==1).forEach(a=>add(`evidence.${a.id}`,'fail','Verifier results must match manifest IDs exactly once'));
  const requireEvidence = (id: string, refs: string[]) => {
    if (!refs?.length || refs.some(ref=>!verified.has(ref))) { add(id,'blocked','Missing or unverified run-bound evidence'); return false; }
    if (refs.some(ref=>byId.get(ref)?.evidenceKind !== c.evidenceKind)) { add(id,'fail','Fixture/native evidence kinds cannot be promoted or mixed'); return false; }
    return true;
  };
  artifacts.filter(a=>a.status !== 'pass').forEach(a=>add(`evidence.${a.id}`,a.status,a.detail));
  const mode = c.events.find(e=>e.type==='target-ready')?.mode ?? c.events[0]?.mode ?? 'unobserved';
  const eventIdentity = c.events.every(e=>e.runId===c.runId && e.scenarioId===c.scenarioId &&
    e.target.appId===c.target.appId && e.target.adapterVersion===c.target.adapterVersion && e.evidenceKind===c.evidenceKind);
  add('identity',eventIdentity?'pass':'fail','Events must match capture run/scenario/adapter and evidence kind');
  for (const event of c.events) if (event.evidenceRefs.length) requireEvidence(`evidence.event-${event.sequence}`,event.evidenceRefs);
  const successEvents = c.events.filter(e=>e.type==='target-ready'||e.type==='chat-applied');
  let previousOperations: NativeReadback['operations'] | null = [];
  const chatChanges = new Map<string,boolean>();
  const checkedIntents = new Set<string>();
  const bindingLimitations = new Set<string>();
  let initialBindingContext: unknown;
  let bindingContextSeen = false;
  if (!successEvents.length) add('readback','blocked','No native readiness event and independent readback captured');
  for (const commit of c.commits) if (!successEvents.some(event=>event.requestId===commit.request.requestId)) add('readback','fail','Commit receipt has no matching successful lifecycle event');
  for (const event of successEvents) {
    const matching = c.commits.filter(commit=>commit.request.requestId===event.requestId);
    if (matching.length !== 1) {add('readback',matching.length?'fail':'blocked','Each readiness/chat event needs exactly one commit receipt');previousOperations=null;continue;}
    const commit = matching[0]; const {request,result,readback} = commit;
    const identity = request.runId===c.runId && request.scenarioId===c.scenarioId &&
      isDeepStrictEqual(request.source,c.source) &&
      request.target.appId===c.target.appId && request.target.adapterVersion===c.target.adapterVersion &&
      commit.generation===event.generation && readback.requestId===request.requestId &&
      result.patch.runId===request.runId && result.patch.requestId===request.requestId && result.patch.scenarioId===request.scenarioId &&
      result.patch.target.appId===c.target.appId && result.patch.target.adapterVersion===c.target.adapterVersion;
    if (!identity) {add('readback','fail','Readback/request generation or identity mismatch');previousOperations=null;continue;}
    if (result.provenance.mode!==event.mode || result.provenance.provider!==event.provider) add('provenance','fail','Success event and planner result provenance disagree');
    const eventEvidence = requireEvidence('readback.event-evidence',event.evidenceRefs);
    const independentEvidence = requireEvidence('readback.observer-evidence',readback.evidenceRefs);
    if (!eventEvidence || !independentEvidence) {previousOperations=null;continue;}
    // Core holds one trusted selection/catalog through this run. Chat cannot
    // insert an exemption, swap its provenance or change the source mapping.
    // Initial preparation may enrich request refs that chat does not retain.
    // Resolve required policy refs per request below; the audit has no original
    // Selection evidence-ref list to infer from that enriched initial request.
    const bindingContext = { policy: request.bindingApplicability,
      catalog: [...request.catalog].sort((a,b)=>a.id.localeCompare(b.id)) };
    if (!bindingContextSeen) { initialBindingContext=structuredClone(bindingContext); bindingContextSeen=true; }
    else add('readback.binding-context',isDeepStrictEqual(bindingContext,initialBindingContext)?'pass':'fail',
      'Binding policy and catalog stay fixed across translate and chat');
    if (request.bindingApplicability && !contracts?.resolveBindingRequirements) {
      add('readback.binding-policy','blocked','This policy requires the accepted host binding resolver; it cannot be interpreted as legacy or skipped');
    } else if (contracts?.resolveBindingRequirements) {
      try {
        // host owns applicability, finite mappings and source-key precedence.
        // QA only compares its result with independently observed operations.
        const requirements=contracts.resolveBindingRequirements(request);
        const preserved=requirements.requiredOperations.every(expected=>readback.operations.some(actual=>
          actual.capabilityId===expected.capabilityId && actual.value===expected.value));
        add('readback.binding-values',preserved?'pass':'fail','Actual native operations preserve every source key required by the accepted host policy');
        requirements.limitations.forEach(limitation=>bindingLimitations.add(limitation));
        add('readback.binding-limitations',requirements.limitations.every(limitation=>result.patch.limitations.includes(limitation))?'pass':'fail',
          'Patch retains exact host-required tool limitations as data; this does not prove shell or native-tooltip disclosure');
        for (const entry of request.bindingApplicability?.entries ?? []) {
          const proof=requireEvidence(`readback.binding-evidence.${entry.sourceAction}`,entry.evidenceRefs);
          if (proof) add(`readback.binding.${entry.sourceAction}`,'pass',
            `Host declares ${entry.status}${entry.status==='mapped'?` (${entry.relation})`:''}; referenced bytes verified. Native meaning and UI disclosure remain independently reviewed.`);
        }
      } catch (error) {
        const code=error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)?error.message:'INVALID_BINDING_POLICY';
        add('readback.binding-policy','fail',`Accepted host binding resolver rejected this context: ${code}`);
      }
    }
    if (previousOperations===null) add('readback','blocked','Prior committed state is unavailable for comparison');
    else if (!equalOperations(request.currentOperations,previousOperations)) add('readback','fail','Request state does not match the last independently observed committed state');
    const usable = readback.targetVisible === true && readback.interactive === true && equalOperations(readback.operations,result.patch.operations);
    add('readback',usable?'pass':'fail','Target is visible, interactive and actual operations equal the validated patch');
    if (event.type==='chat-applied') {
      const intent = request.intent;
      const kinds = intent === 'move-key-panels' ? ['layout'] : intent === 'enlarge-work-area' ? ['canvas','timeline'] : ['tool-layout'];
      const prior=previousOperations;
      const anyChanged = prior!==null && !equalOperations(readback.operations,prior);
      const changed = prior!==null && request.catalog.some(cap=>kinds.includes(cap.kind) && prior.some(old=>old.capabilityId===cap.id &&
        readback.operations.some(now=>now.capabilityId===cap.id&&now.value!==old.value)));
      if (prior!==null && usable && equalOperations(request.currentOperations,prior)) chatChanges.set(request.requestId,anyChanged);
      if (request.kind==='chat' && usable && prior!==null && !anyChanged && intent && chatIntents.includes(intent))
        add(`chat.${intent}.no-op`,'pass','Valid no-op preserves native state; it does not count as demonstrating this chat intent.');
      else add(`chat.${intent}`,prior===null?'blocked':request.kind==='chat'&&changed&&usable?'pass':'fail','Chat changes its intended native capability and preserves the validated full state');
      if (intent && changed && usable) checkedIntents.add(intent);
    } else if (request.kind!=='translate') add('readback','fail','Initial readiness must follow a translate request');
    previousOperations=usable?readback.operations:null;
  }
  const lifecycle = auditLifecycle(c.events,{clockId:c.clockId,runId:c.runId,scenarioId:c.scenarioId,chatChanges});
  findings.push(...lifecycle.findings);
  for(const intent of chatIntents) if(!checkedIntents.has(intent)) add(`chat.${intent}`,'blocked','This approved chat intent has no successful native change evidence');
  const actions = [...taskActions[c.target.appId], ...(c.target.appId==='kdenlive'&&['photoshop','illustrator','gimp'].includes(c.source.sourceApp)?['montage-title']:[])];
  for(const action of actions) {
    const matches=c.tasks.filter(t=>t.action===action);
    if(matches.length!==1) {add(`task.${action}`,'blocked','Capture one before/after observation per approved action');continue;}
    if(requireEvidence(`task.${action}.evidence`,matches[0].evidenceRefs)) {
      const observation=matches[0];
      if (c.target.appId==='krita') {
        const f=checkTask(c.target.appId,observation); add(`task.${action}`,f.status,f.detail);
      } else {
        const snapshot=(state: TaskObservation['before'])=>({
          contextId:'contextId' in state?state.contextId:undefined,
          taskState:state,evidenceRefs:observation.evidenceRefs,
        });
        const checked=validateNativeTask({target:c.target.appId,action,before:snapshot(observation.before),after:snapshot(observation.after)});
        for (const f of checked.findings) add(`task.${action}.${f.id}`,f.status,f.detail);
      }
    }
  }
  if(!c.reset || !c.events.some(e=>e.type==='reset-completed')) add('reset','blocked','Completed reset and native/desktop receipts are required');
  else {
    const nativeEvidence=requireEvidence('reset.native-evidence',c.reset.native.evidenceRefs);
    const desktopEvidence=requireEvidence('reset.desktop-evidence',c.reset.desktop.evidenceRefs);
    const observerEvidence=requireEvidence('reset.observer-evidence',c.reset.evidenceRefs);
    if (nativeEvidence&&desktopEvidence&&observerEvidence) {
    const r=c.reset;
    add('reset', r.native.targetClosed===true&&r.native.preferencesRestored===true&&r.native.visitorArtifactsCleared===true&&
      r.desktop.desktopVisible===true&&r.baselineCompared===true&&r.visitorStateCleared===true&&r.recentsCleared===true&&r.lateWritesObserved===false?'pass':'fail',
      'Reset closes target, compares baseline, clears visitor state/recents, excludes late writes and verifies actual desktop');
    }
  }
  if(!c.relaunch) add('relaunch','blocked','Clean post-reset native relaunch evidence is missing');
  else if(requireEvidence('relaunch.evidence',c.relaunch.evidenceRefs)) add('relaunch',
    c.relaunch.targetVisible===true&&c.relaunch.interactive===true&&c.relaunch.baselineCompared===true&&c.relaunch.visitorStateAbsent===true?'pass':'fail',
    'Relaunch independently confirms usable baseline and no previous visitor state');
  const categories: QAResult['check'][]=['native-task','chat','reset','relaunch','layout','performance'];
  const global = findings.filter(f=>f.id==='collection'||f.id==='identity'||f.id==='provenance'||f.id.startsWith('evidence.')||f.id.startsWith('lifecycle.'));
  const select=(check:QAResult['check'])=>findings.filter(f=>check==='native-task'?f.id.startsWith('task.'):check==='chat'?f.id.startsWith('chat.'):check==='layout'?f.id.startsWith('readback'):check==='performance'?false:f.id.startsWith(check));
  const results=categories.map((check):QAResult=>{
    const readinessDependencies = ['native-task','chat','performance'].includes(check) ? findings.filter(f=>f.id.startsWith('readback')) : [];
    const selected=[...global,...select(check),...readinessDependencies];
    const status=selected.some(f=>f.status==='fail')?'fail':selected.some(f=>f.status==='blocked')||selected.length===0?'blocked':'pass';
    const readableId=`qa:${c.runId}:${check}`;
    const resultId=readableId.length<=160?readableId:`qa:${createHash('sha256').update(c.runId).update('\0').update(check).digest('hex')}`;
    return {version:1,resultId,runId:c.runId,scenarioId:c.scenarioId,target:c.target,
      profileId:c.source.profileId,check,status,evidenceKind:c.evidenceKind,measuredAt:c.capturedAt,
      evidenceRefs:[...verified].slice(0,32),metrics:check==='performance'?lifecycle.metrics:[],
      limitations:['Artifact hashes bind bytes and build/run IDs; native observer authenticity and semantics require independent live review.',
        ...(c.commits.some(commit=>commit.request.bindingApplicability)?['Host binding declarations and documented limits do not prove semantic equivalence, host authorship, shell disclosure or native tooltip rendering. Exact required limits remain in the capture and case report.']:[]),
        ...(c.evidenceKind==='fixture'?['Synthetic fixture evidence; no live native pass.']:[]),
        ...(c.evidenceKind==='native'&&mode!=='live'?[`Native ${mode} evidence does not establish live translation.`]:[]),
        ...(check==='performance'?['Timings describe this local capture; no latency SLO or native frame responsiveness is established.']:[]),
        ...new Set(selected.filter(f=>f.status!=='pass').map(f=>f.detail))].slice(0,12).map(note=>note.slice(0,600))};
  });
  // selected is intentionally prepared/provider none before a planner is chosen.
  const liveNativePass=c.evidenceKind==='native'&&mode==='live'&&successEvents.every(e=>e.mode==='live')&&
    findings.length>0&&findings.every(f=>f.status==='pass')&&results.every(r=>r.status==='pass');
  return {buildId:c.buildId,runId:c.runId,scenarioId:c.scenarioId,sourceApp:c.source.sourceApp,personaId:c.source.personaId,profileRevision:c.source.revision,
    target:c.target,evidenceKind:c.evidenceKind,mode,liveNativePass,findings,results,
    ...(bindingLimitations.size?{bindingLimitations:[...bindingLimitations]}:{})};
}
