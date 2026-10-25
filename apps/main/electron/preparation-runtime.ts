import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateRequest, type PlannerRequest } from '../../../contracts/index.js';
import type { JobInput, PreparationJob, PreparationPort } from '../../../services/preparation/client.js';

export type { PreparationPort } from '../../../services/preparation/client.js';
type JobView = PreparationJob;
export type PreparationSubmission = JobInput extends infer T ? T extends JobInput ? Omit<T, 'version' | 'instanceId' | 'requestId'> : never : never;
export type PreparationCapabilities = { moss: boolean; quiz: boolean; image: boolean };
export type PreparationRuntimeConfig = {
  mode: 'local' | 'hosted'; capabilities: PreparationCapabilities;
  /** Trusted main-process configuration. Never serialize this object to a renderer. */
  environment: NodeJS.ProcessEnv; endpoint?: string; token?: string;
};
const codes = new Set(['PROVIDER_DISABLED', 'PROVIDER_UNAVAILABLE', 'PREPARATION_TIMEOUT', 'PREPARATION_FAILED',
  'WORKER_CLEANUP_UNKNOWN', 'SERVICE_STOPPING', 'QUEUE_FULL', 'JOB_NOT_FOUND', 'JOB_EXPIRED', 'INSTANCE_CHANGED',
  'REQUEST_ID_CONFLICT', 'INSTANCE_REQUEST_LIMIT', 'APIFY_ARTIFACT_UNAVAILABLE', 'INVALID_PREPARATION_INPUT',
  'CONTEXT_NOT_READY', 'CONTEXT_BINDING_MISMATCH', 'CONTEXT_ATTACHMENT_REJECTED', 'UNAUTHORIZED', 'CANCELLED',
  'REQUEST_TOO_LARGE', 'INVALID_REQUEST', 'INVALID_JOB', 'INVALID_IMAGE_ENCODING']);
const runtimeCodes = new Set(['PREPARATION_CONFIG_INVALID', 'PREPARATION_CLOSED', 'PREPARATION_RECOVERY_REQUIRED',
  'PREPARATION_BUSY', 'PREPARATION_ABORTED', 'PREPARATION_RETRIEVAL_REQUIRED', 'PREPARATION_RESPONSE_INVALID',
  'PREPARATION_JOB_REVOKED', 'PREPARATION_UNAVAILABLE']);
const rejectedBeforeAcceptance = new Set(['PROVIDER_DISABLED', 'SERVICE_STOPPING', 'QUEUE_FULL', 'INSTANCE_CHANGED',
  'REQUEST_ID_CONFLICT', 'INSTANCE_REQUEST_LIMIT', 'APIFY_ARTIFACT_UNAVAILABLE', 'INVALID_PREPARATION_INPUT', 'UNAUTHORIZED',
  'REQUEST_TOO_LARGE', 'INVALID_REQUEST', 'INVALID_JOB', 'INVALID_IMAGE_ENCODING']);
export class PreparationRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PreparationRuntimeError'; }
}
const fail = (code: string): never => { throw new PreparationRuntimeError(code); };
function safeError(error: unknown): PreparationRuntimeError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return new PreparationRuntimeError(typeof code === 'string' && (codes.has(code) ||
    (error instanceof PreparationRuntimeError && runtimeCodes.has(code))) ? code : 'PREPARATION_UNAVAILABLE');
}
const environmentKeys = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL',
  'LUCIENNE_PREPARATION_TOKEN', 'LUCIENNE_PREPARATION_MOSS', 'LUCIENNE_PREPARATION_QUIZ',
  'LUCIENNE_PREPARATION_BITDEER', 'MOSS_PROJECT_ID', 'MOSS_PROJECT_KEY', 'LUCIENNE_MOSS_SDK_PATH',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_WORKSPACE_ID', 'BITDEER_API_KEY',
  'LUCIENNE_PREPARATION_APIFY_CORPUS_FILE', 'LUCIENNE_PREPARATION_APIFY_CORPUS_SHA256'] as const;
/** Call only with protected main-process configuration; never with renderer input. */
export function readPreparationRuntimeConfig(env: NodeJS.ProcessEnv = process.env): PreparationRuntimeConfig {
  const mode = env.LUCIENNE_PREPARATION_MODE ?? 'local';
  if (mode !== 'local' && mode !== 'hosted') return fail('PREPARATION_CONFIG_INVALID');
  const enabled = (name: string) => {
    if (env[name] !== undefined && !['0', '1'].includes(env[name]!)) fail('PREPARATION_CONFIG_INVALID');
    return env[name] === '1';
  };
  const capabilities = { moss: enabled('LUCIENNE_PREPARATION_MOSS'), quiz: enabled('LUCIENNE_PREPARATION_QUIZ'),
    image: enabled('LUCIENNE_PREPARATION_BITDEER') };
  if (mode === 'hosted') {
    try {
      const supplied = env.LUCIENNE_PREPARATION_URL ?? '';
      const endpoint = new URL(supplied);
      const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
      if ((endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:'))
        || endpoint.username || endpoint.password || endpoint.pathname !== '/'
        || endpoint.search || endpoint.hash || /[?#]/.test(supplied) || !/^[a-f0-9]{64}$/.test(env.LUCIENNE_PREPARATION_TOKEN ?? '')) throw Error();
      return { mode, capabilities, environment: {}, endpoint: endpoint.origin, token: env.LUCIENNE_PREPARATION_TOKEN };
    } catch { return fail('PREPARATION_CONFIG_INVALID'); }
  }
  // Provider opt-ins are identical in either mode. Curated retrieval is chosen per request.
  const environment: NodeJS.ProcessEnv = {};
  for (const key of environmentKeys) if (env[key] !== undefined) environment[key] = env[key];
  return { mode, capabilities, environment };
}

const uuid = z.string().uuid();
const jobSchema = z.object({ version: z.literal(1), instanceId: uuid, jobId: uuid, requestId: z.string().max(160),
  kind: z.enum(['context', 'quiz', 'image']), status: z.enum(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'expired']),
  createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional(),
  code: z.string().optional(), result: z.unknown().optional(), nativeVerified: z.literal(false), remoteComputationStopped: z.null() });
const statusSchema = z.object({ version: z.literal(1), instanceId: uuid, stopping: z.boolean(),
  capabilities: z.object({ context: z.literal('local-curated'), moss: z.boolean(), quiz: z.boolean(), image: z.boolean(), apifyArtifact: z.boolean() }),
  queued: z.number().int().nonnegative(), running: z.number().int().nonnegative() });
const terminal = (status: JobView['status']) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(status);
// Match the service's result cap without importing its ESM worker graph into Electron's CJS bundle.
const MAX_JOB_RESULT_BYTES = 512 * 1024;
const MAX_JOB_ENVELOPE_BYTES = 64 * 1024;
type Owned = { view: JobView; generation: number; revoked: boolean };
type Call = { controller: AbortController; settled: Promise<void> };

/** Main-process owner of preparation lifetime; independent of the native coordinator. */
export class PreparationRuntime {
  private config: PreparationRuntimeConfig;
  private port?: PreparationPort;
  private instanceId?: string;
  private generation = 0;
  private calls = new Set<Call>();
  private jobs = new Map<string, Owned>();
  private recoveryRequired = false;
  private resetting?: Promise<void>;
  private switching = false;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly options: { config: PreparationRuntimeConfig;
    /** Main loads the fixed ESM client sidecar, preserving import.meta.url worker paths. */
    createPort(config: PreparationRuntimeConfig): PreparationPort;
    isSessionActive(): boolean; cleanupTimeoutMs?: number }) {
    this.config = structuredClone(options.config);
  }
  snapshot() {
    return { mode: this.config.mode, capabilities: { context: 'local-curated' as const, ...this.config.capabilities },
      busy: this.calls.size > 0 || !!this.resetting || !!this.closing || this.switching || [...this.jobs.values()].some(job => !terminal(job.view.status)),
      recoveryRequired: this.recoveryRequired, closed: this.closed };
  }
  private available() {
    if (this.closed || this.closing) fail('PREPARATION_CLOSED');
    if (this.recoveryRequired) fail('PREPARATION_RECOVERY_REQUIRED');
    if (this.resetting || this.switching) fail('PREPARATION_BUSY');
  }
  private getPort(): PreparationPort {
    try { return this.port ??= this.options.createPort(structuredClone(this.config)); }
    catch (error) { throw safeError(error); }
  }
  private async call<T>(action: (signal: AbortSignal, generation: number) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.available();
    if (signal?.aborted) return fail('PREPARATION_ABORTED');
    const generation = this.generation, controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let settle!: () => void;
    const call: Call = { controller, settled: new Promise<void>(resolve => { settle = resolve; }) };
    this.calls.add(call);
    try {
      const result = await action(controller.signal, generation);
      if (controller.signal.aborted || generation !== this.generation || this.closed || this.closing) fail('PREPARATION_ABORTED');
      return result;
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) fail('PREPARATION_ABORTED');
      throw safeError(error);
    } finally { signal?.removeEventListener('abort', abort); this.calls.delete(call); settle(); }
  }
  private async inspect(signal: AbortSignal) {
    let status: z.infer<typeof statusSchema>;
    try { status = statusSchema.parse(await this.getPort().status(signal)); }
    catch (error) { throw safeError(error); }
    if (status.stopping) fail('SERVICE_STOPPING');
    if (this.instanceId && this.instanceId !== status.instanceId) {
      this.recoveryRequired = true; fail('INSTANCE_CHANGED');
    }
    for (const key of ['moss', 'quiz', 'image'] as const) {
      if (this.config.capabilities[key] && !status.capabilities[key]) fail('PROVIDER_DISABLED');
    }
    this.instanceId = status.instanceId;
    return { ...status, capabilities: { context: 'local-curated' as const, ...this.config.capabilities, apifyArtifact: status.capabilities.apifyArtifact } };
  }
  status(signal?: AbortSignal) { return this.call(s => this.inspect(s), signal); }
  private parseJob(raw: unknown, instanceId: string, jobId?: string): JobView {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error();
      const { result, ...envelope } = raw as Record<string, unknown>;
      if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_JOB_ENVELOPE_BYTES ||
        (result !== undefined && Buffer.byteLength(JSON.stringify(result)) > MAX_JOB_RESULT_BYTES)) throw Error();
      const parsed = jobSchema.parse(raw);
      if (parsed.instanceId !== instanceId || (jobId && parsed.jobId !== jobId)) throw Error();
      if (parsed.code) parsed.code = codes.has(parsed.code) ? parsed.code : 'PREPARATION_FAILED';
      if (parsed.status !== 'succeeded') delete parsed.result;
      return parsed as JobView;
    } catch { return fail('PREPARATION_RESPONSE_INVALID'); }
  }
  submit(input: PreparationSubmission, signal?: AbortSignal): Promise<JobView> {
    return this.call(async (s, generation) => {
      const status = await this.inspect(s);
      if (s.aborted || generation !== this.generation || this.closed || this.closing) fail('PREPARATION_ABORTED');
      if (input.kind === 'context') {
        if (!['moss', 'local-curated'].includes(input.retrieval)) fail('PREPARATION_RETRIEVAL_REQUIRED');
        if (input.retrieval === 'moss' && !this.config.capabilities.moss) fail('PROVIDER_DISABLED');
      } else if (!(input.kind === 'quiz' ? this.config.capabilities.quiz : input.kind === 'image' && this.config.capabilities.image)) fail('PROVIDER_DISABLED');
      const requestId = randomUUID();
      let preparedInput: JobInput;
      try { preparedInput = { ...structuredClone(input), version: 1, instanceId: status.instanceId, requestId } as JobInput; }
      catch { return fail('INVALID_REQUEST'); }
      let raw: JobView;
      try { raw = await this.getPort().submit(preparedInput, s); }
      catch (error) {
        // A lost acceptance may represent a running paid job. Never replay it automatically.
        if (!(error && typeof error === 'object' && 'code' in error && rejectedBeforeAcceptance.has(String(error.code)))) this.recoveryRequired = true;
        throw error;
      }
      let view: JobView;
      try { view = this.parseJob(raw, status.instanceId); }
      catch (error) { this.recoveryRequired = true; throw error; }
      if (view.requestId !== requestId || view.kind !== input.kind) { this.recoveryRequired = true; fail('PREPARATION_RESPONSE_INVALID'); }
      this.jobs.set(view.jobId, { view, generation, revoked: s.aborted || generation !== this.generation });
      if (s.aborted || generation !== this.generation || this.closed || this.closing) {
        await this.cancelOwned(view.jobId);
        fail('PREPARATION_ABORTED');
      }
      return structuredClone(view);
    }, signal);
  }
  private owned(jobId: string): Owned {
    const owned = this.jobs.get(jobId);
    if (!owned || owned.revoked || owned.generation !== this.generation) return fail('PREPARATION_JOB_REVOKED');
    return owned;
  }
  get(jobId: string, signal?: AbortSignal): Promise<JobView> {
    return this.call(async s => {
      const owned = this.owned(jobId);
      const view = this.parseJob(await this.getPort().get(jobId, s), this.instanceId!, jobId);
      if (this.owned(jobId) !== owned) fail('PREPARATION_JOB_REVOKED');
      if (view.kind !== owned.view.kind || view.requestId !== owned.view.requestId) fail('PREPARATION_RESPONSE_INVALID');
      owned.view = view;
      return structuredClone(view);
    }, signal);
  }
  private async cancelOwned(jobId: string): Promise<void> {
    const owned = this.jobs.get(jobId);
    if (!owned) return;
    owned.revoked = true; delete owned.view.result;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.cleanupTimeoutMs ?? 5000);
    try {
      let view = this.parseJob(await this.getPort().cancel(jobId, controller.signal), owned.view.instanceId, jobId);
      while (!['cancelled', 'expired'].includes(view.status)) {
        if (controller.signal.aborted) fail('PREPARATION_RECOVERY_REQUIRED');
        await new Promise(resolve => setTimeout(resolve, 20));
        view = this.parseJob(await this.getPort().get(jobId, controller.signal), owned.view.instanceId, jobId);
      }
      owned.view = view;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['JOB_NOT_FOUND', 'JOB_EXPIRED'].includes(String(error.code))) {
        try {
          const status = statusSchema.parse(await this.getPort().status(controller.signal));
          if (status.instanceId === owned.view.instanceId && !status.stopping) { owned.view.status = 'expired'; return; }
        } catch { /* An absent job on an unknown/replaced server is not cleanup proof. */ }
      }
      this.recoveryRequired = true; fail('PREPARATION_RECOVERY_REQUIRED');
    } finally { clearTimeout(timer); }
  }
  cancel(jobId: string): Promise<void> {
    this.available(); this.owned(jobId);
    return this.call(() => this.cancelOwned(jobId));
  }
  attach(jobIds: string[], raw: PlannerRequest, signal?: AbortSignal): Promise<PlannerRequest> {
    return this.call(async s => {
      const request = validateRequest(structuredClone(raw));
      if (request.kind !== 'translate' || !jobIds.length || jobIds.length > 4 || new Set(jobIds).size !== jobIds.length) fail('CONTEXT_ATTACHMENT_REJECTED');
      const owned = jobIds.map(id => this.owned(id));
      if (owned.some(job => job.view.kind !== 'context' || job.view.status !== 'succeeded')) fail('CONTEXT_NOT_READY');
      const result = await this.getPort().attach({ version: 1, instanceId: this.instanceId!, jobIds: [...jobIds], request }, s);
      jobIds.forEach((id, i) => { if (this.owned(id) !== owned[i]) fail('PREPARATION_JOB_REVOKED'); });
      let attached: PlannerRequest;
      try { attached = validateRequest(result.request); }
      catch { return fail('CONTEXT_ATTACHMENT_REJECTED'); }
      const immutable = ({ instruction: _instruction, evidenceRefs: _evidenceRefs, ...rest }: PlannerRequest) => rest;
      if (result.version !== 1 || JSON.stringify(immutable(attached)) !== JSON.stringify(immutable(request))
        || request.evidenceRefs.some(ref => !attached.evidenceRefs.includes(ref))) fail('CONTEXT_ATTACHMENT_REJECTED');
      return attached;
    }, signal);
  }
  async configure(config: PreparationRuntimeConfig): Promise<void> {
    this.available();
    if (this.snapshot().busy || this.options.isSessionActive()) fail('PREPARATION_BUSY');
    this.switching = true;
    try {
      // Completed cached contexts belong to the old provider/instance too.
      await this.reset();
      if (this.options.isSessionActive()) fail('PREPARATION_BUSY');
      await this.port?.close(); this.port = undefined; this.instanceId = undefined;
      if (this.closed || this.closing) fail('PREPARATION_CLOSED');
      if (this.options.isSessionActive()) fail('PREPARATION_BUSY');
      this.config = structuredClone(config);
    } catch (error) {
      if (!(error instanceof PreparationRuntimeError && ['PREPARATION_BUSY', 'PREPARATION_CLOSED'].includes(error.code))) this.recoveryRequired = true;
      throw safeError(error);
    }
    finally { this.switching = false; }
  }
  reset(): Promise<void> {
    if (this.resetting) return this.resetting;
    this.generation++;
    for (const owned of this.jobs.values()) { owned.revoked = true; delete owned.view.result; }
    const calls = [...this.calls]; calls.forEach(call => call.controller.abort());
    this.resetting = (async () => {
      await Promise.all(calls.map(call => call.settled));
      const results = await Promise.allSettled([...this.jobs.keys()].map(id => this.cancelOwned(id)));
      if (results.some(result => result.status === 'rejected') || this.recoveryRequired) fail('PREPARATION_RECOVERY_REQUIRED');
      this.jobs.clear();
    })().finally(() => { this.resetting = undefined; });
    return this.resetting;
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    // Defer work one microtask so the latch is installed before reset or port callbacks.
    this.closing = Promise.resolve().then(async () => {
      let error: unknown;
      try { await this.reset(); } catch (caught) { error = caught; }
      try { await this.port?.close(); } catch (caught) { error ??= caught; }
      if (error) { this.recoveryRequired = true; throw safeError(error); }
      this.closed = true;
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
