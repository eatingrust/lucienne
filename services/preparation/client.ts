import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { validateRequest } from '../../contracts/index.js';
import type { PlannerRequest } from '../../contracts/index.js';
import { LIMITS, PreparationJobs, ServiceError } from './server/jobs.js';
import type { JobInput, JobServiceOptions } from './server/jobs.js';
import type { ImportedOfficialDocument } from './providers/apify.js';

export type { JobInput } from './server/jobs.js';
export type PreparationStatus = ReturnType<PreparationJobs['status']>;
export type PreparationJob = ReturnType<PreparationJobs['get']>;
export interface PreparationAttachment { version: 1; instanceId: string; jobIds: string[]; request: PlannerRequest }
export interface PreparationPort {
  readonly mode: 'local' | 'hosted';
  status(signal: AbortSignal): Promise<PreparationStatus>;
  submit(input: JobInput, signal: AbortSignal): Promise<PreparationJob>;
  get(jobId: string, signal: AbortSignal): Promise<PreparationJob>;
  cancel(jobId: string, signal: AbortSignal): Promise<PreparationJob>;
  attach(input: PreparationAttachment, signal: AbortSignal): Promise<{ version: 1; request: PlannerRequest }>;
  close(): Promise<void>;
}
const SERVICE_CODES = ['UNAUTHORIZED','BROWSER_ORIGIN_REJECTED','SERVICE_STOPPING','INVALID_JOB','INSTANCE_CHANGED',
  'REQUEST_ID_CONFLICT','JOB_EXPIRED','INSTANCE_REQUEST_LIMIT','QUEUE_FULL','PROVIDER_DISABLED','APIFY_ARTIFACT_UNAVAILABLE',
  'INVALID_PREPARATION_INPUT','INVALID_IMAGE_ENCODING','JOB_NOT_FOUND','INVALID_ATTACHMENT','DUPLICATE_JOB','CONTEXT_NOT_READY',
  'CONTEXT_BINDING_MISMATCH','CONTEXT_ATTACHMENT_REJECTED','JSON_REQUIRED','BODY_TOO_LARGE','BODY_TIMEOUT','INVALID_BODY',
  'REQUEST_ABORTED','INVALID_JSON','NOT_FOUND'] as const;
type ServiceCode = typeof SERVICE_CODES[number];
export type PreparationClientErrorCode = ServiceCode | 'INVALID_CONFIGURATION' | 'INVALID_REQUEST' | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE' | 'REQUEST_TOO_LARGE' | 'REDIRECT_REJECTED' | 'NETWORK_ERROR' | 'TIMEOUT' | 'CANCELLED'
  | 'CLIENT_CLOSED' | 'NOT_READY' | 'SERVICE_ERROR' | 'SUBMISSION_OUTCOME_UNKNOWN' | 'CLEANUP_UNCONFIRMED';
export class PreparationClientError extends Error {
  constructor(readonly code: PreparationClientErrorCode, readonly reason?: PreparationClientErrorCode) {
    super(code); this.name = 'PreparationClientError';
  }
}
const fail = (code: PreparationClientErrorCode): never => { throw new PreparationClientError(code); };
const MAX_RESPONSE_BYTES=LIMITS.resultBytes+64*1024;
const uuid = z.string().uuid().transform(value=>value as PreparationStatus['instanceId']);
const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const statusSchema = z.strictObject({ version: z.literal(1), instanceId: uuid, stopping: z.boolean(),
  capabilities: z.strictObject({ context: z.literal('local-curated'), moss:z.boolean(),quiz:z.boolean(),image:z.boolean(),apifyArtifact:z.boolean() }),
  limits: z.strictObject(Object.fromEntries(Object.entries(LIMITS).map(([key,value])=>[key,z.literal(value)])) as { [K in keyof typeof LIMITS]: z.ZodLiteral<(typeof LIMITS)[K]> }),
  queued:z.number().int().nonnegative().max(LIMITS.maxQueued), running:z.number().int().min(0).max(1) });
const jobSchema = z.strictObject({ version:z.literal(1),instanceId:uuid,jobId:uuid,requestId:identifier,
  kind:z.enum(['context','quiz','image']),status:z.enum(['queued','running','cancelling','succeeded','failed','cancelled','expired']),
  createdAt:z.iso.datetime(),finishedAt:z.iso.datetime().optional(),expiresAt:z.iso.datetime().optional(),
  code:identifier.optional(),result:z.unknown().optional(),nativeVerified:z.literal(false),remoteComputationStopped:z.null() });
function checkedJob(raw: unknown): PreparationJob {
  const job=jobSchema.parse(raw);
  if (job.status==='succeeded' ? job.result===undefined : job.result!==undefined) fail('INVALID_RESPONSE');
  if (job.code && !['CANCELLED','SERVICE_STOPPING','WORKER_CLEANUP_UNKNOWN','PREPARATION_TIMEOUT','PROVIDER_UNAVAILABLE','PREPARATION_FAILED'].includes(job.code)) fail('INVALID_RESPONSE');
  return job;
}
function checkedAttachment(input: PreparationAttachment, raw: unknown) {
  if (!raw || typeof raw!=='object' || Array.isArray(raw) || Object.keys(raw).length!==2
      || !('version' in raw) || raw.version!==1 || !('request' in raw)) return fail('INVALID_RESPONSE');
  const before=validateRequest(input.request),after=validateRequest(raw.request);
  if (!isDeepStrictEqual({...before,instruction:'',evidenceRefs:[]},{...after,instruction:'',evidenceRefs:[]})
      || (before.instruction && after.instruction!==before.instruction && !after.instruction.startsWith(`${before.instruction}\n`))
      || after.evidenceRefs.length<before.evidenceRefs.length
      || before.evidenceRefs.some((ref,index)=>after.evidenceRefs[index]!==ref)
      || new Set(after.evidenceRefs).size!==after.evidenceRefs.length) return fail('INVALID_RESPONSE');
  return {version:1 as const,request:after};
}
function body(value: unknown): string {
  let text: string;
  try { text=JSON.stringify(value); } catch { return fail('INVALID_REQUEST'); }
  if (typeof text!=='string') return fail('INVALID_REQUEST');
  if (Buffer.byteLength(text)>LIMITS.bodyBytes) return fail('REQUEST_TOO_LARGE');
  return text;
}
function signalReady(signal: AbortSignal) { if (signal.aborted) fail('CANCELLED'); }
function safeServiceError(error: unknown): PreparationClientError {
  return error instanceof ServiceError && (SERVICE_CODES as readonly string[]).includes(error.code)
    ? new PreparationClientError(error.code as ServiceCode) : new PreparationClientError('SERVICE_ERROR');
}

export interface HttpPreparationClientOptions {
  baseUrl: string;
  token: string;
  /** Trusted transport/deadline seams; caller cannot raise the ten-second ceiling. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export function createHttpPreparationClient(options: HttpPreparationClientOptions): PreparationPort {
  let base: URL;
  try { base=new URL(options.baseUrl); } catch { return fail('INVALID_CONFIGURATION'); }
  const loopback=['127.0.0.1','[::1]','localhost'].includes(base.hostname);
  const timeoutMs=options.timeoutMs??10_000;
  if (base.username || base.password || (base.pathname!=='' && base.pathname!=='/') || base.search || base.hash || /[?#]/.test(options.baseUrl)
      || !['https:','http:'].includes(base.protocol) || (base.protocol==='http:' && !loopback)
      || !/^[a-f0-9]{64}$/.test(options.token) || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>10_000) return fail('INVALID_CONFIGURATION');
  const token=options.token,fetchImpl=options.fetchImpl??fetch;
  let closed=false,instanceId:string|undefined,closing:Promise<void>|undefined,cleanupUnknown=false;
  const controllers=new Set<AbortController>(),pending=new Set<Promise<unknown>>();
  const ownedJobs=new Set<string>(),revokingJobs=new Set<string>(),uncertainRequests=new Set<string>();
  const terminal=(job:PreparationJob)=>['succeeded','failed','cancelled','expired'].includes(job.status);
  const track=(job:PreparationJob)=>{
    if(job.code==='WORKER_CLEANUP_UNKNOWN')cleanupUnknown=true;
    if(revokingJobs.has(job.jobId)&&terminal(job)&&job.result===undefined&&job.code!=='WORKER_CLEANUP_UNKNOWN'){
      ownedJobs.delete(job.jobId);revokingJobs.delete(job.jobId);
    }else ownedJobs.add(job.jobId);
  };
  const bind=(id:string) => { if(instanceId!==undefined && instanceId!==id) fail('INSTANCE_CHANGED');instanceId=id; };
  const requireInstance=(id?:string) => { if(id!==undefined) { if(!uuid.safeParse(id).success) fail('INVALID_REQUEST');bind(id); } else if(!instanceId) fail('NOT_READY'); };
  const jobId=(id:string) => { if(!uuid.safeParse(id).success) fail('INVALID_REQUEST');return id; };
  async function read(response:Response,signal:AbortSignal):Promise<unknown> {
    const length=response.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length)>MAX_RESPONSE_BYTES)) { void response.body?.cancel().catch(()=>{});return fail('RESPONSE_TOO_LARGE'); }
    if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json') return fail('INVALID_RESPONSE');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    const cancel=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
    try {
      while(true) {signal.throwIfAborted();const part=await reader.read();signal.throwIfAborted();if(part.done)break;
        size+=part.value.byteLength;if(size>MAX_RESPONSE_BYTES)return fail('RESPONSE_TOO_LARGE');chunks.push(part.value);}
      const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      if(text.includes(token)) return fail('INVALID_RESPONSE');
      try{const decoded:unknown=JSON.parse(text);if(JSON.stringify(decoded).includes(token))return fail('INVALID_RESPONSE');return decoded;}
      catch{return fail('INVALID_RESPONSE');}
    } finally {cancel();signal.removeEventListener('abort',cancel);reader.releaseLock();}
  }
  function request<T>(path:string,method:string,input:unknown,signal:AbortSignal,validate:(raw:unknown)=>T,submissionId?:string,allowClosed=false):Promise<T> {
    if(closed&&!allowClosed)return Promise.reject(new PreparationClientError('CLIENT_CLOSED'));
    try{signalReady(signal);}catch(error){return Promise.reject(error);}
    let serialized:string|undefined;
    try{serialized=input===undefined?undefined:body(input);}catch(error){return Promise.reject(error);}
    const controller=new AbortController();controllers.add(controller);let attempted=false,definitiveRejection=false;
    const onAbort=()=>controller.abort('CANCELLED');signal.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>controller.abort('TIMEOUT'),timeoutMs);
    let interrupted:()=>void=()=>{};
    const cancelled=new Promise<never>((_,reject)=>{interrupted=()=>reject(new PreparationClientError(controller.signal.reason==='TIMEOUT'?'TIMEOUT':controller.signal.reason==='CLIENT_CLOSED'?'CLIENT_CLOSED':'CANCELLED'));controller.signal.addEventListener('abort',interrupted,{once:true});});
    const operation=async()=>{
      controller.signal.throwIfAborted();attempted=true;
      const response=await fetchImpl(new URL(path,base).href,{method,redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${token}`,accept:'application/json',...(serialized===undefined?{}:{'content-type':'application/json'})},...(serialized===undefined?{}:{body:serialized})});
      controller.signal.throwIfAborted();
      if(response.redirected || (response.status>=300&&response.status<400) || (response.url&&response.url!==new URL(path,base).href)) {void response.body?.cancel().catch(()=>{});return fail('REDIRECT_REJECTED');}
      const raw=await read(response,controller.signal);
      if(!response.ok) {
        const code=raw&&typeof raw==='object'&&!Array.isArray(raw)&&'version' in raw&&raw.version===1&&'code' in raw&&typeof raw.code==='string'&&(SERVICE_CODES as readonly string[]).includes(raw.code)?raw.code as ServiceCode:undefined;
        if(code && (response.status<500 || ['SERVICE_STOPPING','PROVIDER_DISABLED','APIFY_ARTIFACT_UNAVAILABLE'].includes(code))) {definitiveRejection=true;throw new PreparationClientError(code);}
        return fail('SERVICE_ERROR');
      }
      if(response.status!==(method==='POST'&&path==='/v1/jobs'?202:200)) return fail('INVALID_RESPONSE');
      try{return validate(raw);}catch(error){if(error instanceof PreparationClientError)throw error;return fail('INVALID_RESPONSE');}
    };
    const result=(async()=>{
      try { if(signal.aborted)onAbort();return await Promise.race([operation(),cancelled]); }
      catch(error) {
        const safe=error instanceof PreparationClientError?error:new PreparationClientError('NETWORK_ERROR');
        if(submissionId&&attempted&&!definitiveRejection){uncertainRequests.add(submissionId);throw new PreparationClientError('SUBMISSION_OUTCOME_UNKNOWN',safe.code);}
        throw safe;
      } finally {clearTimeout(timer);signal.removeEventListener('abort',onAbort);controller.signal.removeEventListener('abort',interrupted);controller.abort();controllers.delete(controller);}
    })();
    pending.add(result);void result.finally(()=>pending.delete(result)).catch(()=>{});return result;
  }
  const cancelJob=(id:string,signal:AbortSignal,allowClosed=false)=>request(`/v1/jobs/${jobId(id)}`,'DELETE',undefined,signal,raw=>{
    const job=checkedJob(raw);bind(job.instanceId);if(job.jobId!==id)fail('INVALID_RESPONSE');revokingJobs.add(id);track(job);return job;
  },undefined,allowClosed);
  const getJob=(id:string,signal:AbortSignal,allowClosed=false)=>request(`/v1/jobs/${jobId(id)}`,'GET',undefined,signal,raw=>{
    const job=checkedJob(raw);bind(job.instanceId);if(job.jobId!==id)fail('INVALID_RESPONSE');if(ownedJobs.has(id)||job.code==='WORKER_CLEANUP_UNKNOWN')track(job);return job;
  },undefined,allowClosed);
  const readStatus=(signal:AbortSignal,allowClosed=false)=>request('/v1/status','GET',undefined,signal,raw=>{
    const status=statusSchema.parse(raw);bind(status.instanceId);return status;
  },undefined,allowClosed);
  return {
    mode:'hosted',
    status:signal=>readStatus(signal),
    async submit(input,signal){input=JSON.parse(body(input)) as JobInput;requireInstance(input.instanceId);const job=await request('/v1/jobs','POST',input,signal,raw=>{
      const job=checkedJob(raw);bind(job.instanceId);if(job.requestId!==input.requestId||job.kind!==input.kind)fail('INVALID_RESPONSE');return job;
    },input.requestId);track(job);uncertainRequests.delete(input.requestId);return job;},
    async get(id,signal){requireInstance();return getJob(id,signal);},
    async cancel(id,signal){requireInstance();return cancelJob(id,signal);},
    async attach(input,signal){input=JSON.parse(body(input)) as PreparationAttachment;requireInstance(input.instanceId);try{validateRequest(input.request);}catch{return fail('INVALID_REQUEST');}return request('/v1/attach','POST',input,signal,raw=>checkedAttachment(input,raw));},
    close(){
      if(closing)return closing;
      closed=true;for(const controller of controllers)controller.abort('CLIENT_CLOSED');
      closing=(async()=>{
        const cleanup=new AbortController(),timer=setTimeout(()=>cleanup.abort(),10_000);let failed=false;
        const pause=()=>new Promise<void>((resolve,reject)=>{
          const abort=()=>{clearTimeout(delay);reject(new PreparationClientError('CANCELLED'));};
          const delay=setTimeout(()=>{cleanup.signal.removeEventListener('abort',abort);resolve();},50);
          cleanup.signal.addEventListener('abort',abort,{once:true});if(cleanup.signal.aborted)abort();
        });
        try{
          await Promise.allSettled([...pending]);const ids=[...ownedJobs];let cursor=0;
          await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
            while(cursor<ids.length&&!cleanup.signal.aborted){const id=ids[cursor++]!;
              try{
                let job=await cancelJob(id,cleanup.signal,true);
                while(!terminal(job)){await pause();job=await getJob(id,cleanup.signal,true);}
                if(job.code==='WORKER_CLEANUP_UNKNOWN')failed=true;
              }catch(error){
                if(error instanceof PreparationClientError&&['JOB_NOT_FOUND','JOB_EXPIRED'].includes(error.code)){
                  try{
                    const status=await readStatus(cleanup.signal,true);
                    if(status.stopping)failed=true;
                    else{ownedJobs.delete(id);revokingJobs.delete(id);}
                  }catch{failed=true;}
                }else failed=true;
              }
            }
          }));
          if(failed||cleanupUnknown||uncertainRequests.size||ownedJobs.size||cleanup.signal.aborted)fail('CLEANUP_UNCONFIRMED');
        }finally{clearTimeout(timer);cleanup.abort();}
      })();return closing;
    },
  };
}

export interface LocalPreparationClientOptions {
  capabilities?: JobServiceOptions['capabilities'];
  workerEnv?: NodeJS.ProcessEnv;
  apifyDocuments?: ImportedOfficialDocument[];
  /** Trusted tests only; never expose through HTTP or renderer input. */
  executeWorker?: JobServiceOptions['executeWorker'];
  /** May shorten the local close deadline; never exceed ten seconds. */
  closeTimeoutMs?: number;
}
export function createLocalPreparationClient(options:LocalPreparationClientOptions={}):PreparationPort {
  const capabilities=options.capabilities??{moss:false,quiz:false,image:false},env={...(options.workerEnv??{})};
  const closeTimeoutMs=options.closeTimeoutMs??10_000;
  const secret=(name:string)=>typeof env[name]==='string'&&/^[!-~]{8,8192}$/.test(env[name]!);
  if(!Number.isSafeInteger(closeTimeoutMs)||closeTimeoutMs<1||closeTimeoutMs>10_000
      || Object.keys(capabilities).length!==3 || !['moss','quiz','image'].every(key=>typeof capabilities[key as keyof typeof capabilities]==='boolean')
      || (capabilities.moss&&(!secret('MOSS_PROJECT_KEY')||!env.MOSS_PROJECT_ID||/\s/.test(env.MOSS_PROJECT_ID)))
      || (capabilities.quiz&&!secret('ANTHROPIC_API_KEY')) || (capabilities.image&&!secret('BITDEER_API_KEY')))return fail('INVALID_CONFIGURATION');
  const jobs=new PreparationJobs({capabilities:{...capabilities},workerEnv:env,apifyDocuments:options.apifyDocuments,executeWorker:options.executeWorker});
  let closed=false,closing:Promise<void>|undefined;
  async function run<T>(signal:AbortSignal,action:()=>T):Promise<T>{if(closed)fail('CLIENT_CLOSED');signalReady(signal);try{return action();}catch(error){if(error instanceof PreparationClientError)throw error;throw safeServiceError(error);}}
  return {mode:'local',status:signal=>run(signal,()=>jobs.status()),
    submit:(input,signal)=>run(signal,()=>{body(input);return jobs.submit(input);}),
    get:(id,signal)=>run(signal,()=>jobs.get(id)),cancel:(id,signal)=>run(signal,()=>jobs.cancel(id)),
    attach:(input,signal)=>run(signal,()=>{body(input);return checkedAttachment(input,jobs.attach(input));}),
    close(){
      if(!closing){closed=true;closing=(async()=>{
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([jobs.close(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PreparationClientError('CLEANUP_UNCONFIRMED')),closeTimeoutMs);})]);}
        catch{return fail('CLEANUP_UNCONFIRMED');}finally{clearTimeout(timer);}
      })();}return closing;
    },
  };
}
