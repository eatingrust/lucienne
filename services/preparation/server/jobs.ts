import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PlannerRequestSchema, QuizTurnSchema, QuizResultSchema, SourceProfileSchema, TargetSchema, assertRoute, validateRequest } from '../../../contracts/index.js';
import type { PlannerRequest } from '../../../contracts/index.js';
import { prepareCuratedContext, PreparedContextStore } from '../retrieval.js';
import type { PreparedEvidence } from '../retrieval.js';
import { attachPreparedEvidence } from '../planner-context.js';
import { parseImageObservations } from '../providers/bitdeer.js';
import { sourceFingerprint, selectContextRecipe, validateServiceSource } from './recipes.js';
import { runPreparationWorker, PreparationWorkerError } from './worker-client.js';
import type { PreparationWorkerTask } from './worker-client.js';
import type { ServiceConfig } from './config.js';
import { apifyContextRecipe } from './apify-artifact.js';
import type { ImportedOfficialDocument } from '../providers/apify.js';

export const LIMITS = Object.freeze({ bodyBytes: 128 * 1024, resultBytes: 512 * 1024, maxQueued: 8,
  maxRetained: 32, maxRequestsPerInstance: 512, retentionMs: 10 * 60_000, jobMs: 120_000 });
const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const common = { version: z.literal(1), instanceId: z.string().uuid(), requestId: id };
const contextSchema = z.strictObject({ ...common, kind: z.literal('context'), source: SourceProfileSchema,
  target: TargetSchema, recipe: z.enum(['source-reference', 'target-reference', 'persona', 'apify-reference']), retrieval: z.enum(['moss', 'local-curated']) });
const quizSchema = z.strictObject({ ...common, kind: z.literal('quiz'), input: z.strictObject({ source: SourceProfileSchema,
  turns: z.array(QuizTurnSchema).max(48), userEvidence: z.array(z.strictObject({ turnId: id, evidenceRef: id })).max(24),
  nextRevision: id, invocationEvidenceRef: id }) });
const imageSchema = z.strictObject({ ...common, kind: z.literal('image'), source: z.strictObject({
  captureId: id, appId: id, appVersion: id, capturedAt: z.iso.datetime(), kind: z.enum(['synthetic-fixture', 'native-capture']),
}), imageBase64: z.string().min(44).max(110_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) });
const submission = z.discriminatedUnion('kind', [contextSchema, quizSchema, imageSchema]);
export type JobInput = z.infer<typeof submission>;
type Status = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
type Job = { jobId: string; requestId: string; kind: JobInput['kind']; status: Status; createdAt: string;
  finishedAt?: string; expiresAt?: string; code?: string; result?: unknown; input?: JobInput;
  binding?: { sourceHash: string; target: z.infer<typeof TargetSchema> };
  recipe?: ReturnType<typeof selectContextRecipe>; controller: AbortController };
export class ServiceError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const fail = (status: number, code: string): never => { throw new ServiceError(status, code); };
const terminal = (job: Job) => ['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface JobServiceOptions {
  capabilities: ServiceConfig['capabilities']; workerEnv?: NodeJS.ProcessEnv;
  apifyDocuments?: ImportedOfficialDocument[];
  executeWorker?: (task: PreparationWorkerTask, options: { signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<unknown>;
  now?: () => number;
}

/** One authenticated trusted application per service instance; no passive companion/browser access. */
export class PreparationJobs {
  readonly instanceId = randomUUID();
  private readonly jobs = new Map<string, Job>();
  private readonly requests = new Map<string, { digest: string; jobId: string }>();
  private active?: Promise<void>;
  private stopping = false;
  private cleanupUnconfirmed = false;
  private readonly now: () => number;
  constructor(private readonly options: JobServiceOptions) { this.now = options.now ?? Date.now; }

  status() {
    this.expire();
    return { version: 1, instanceId: this.instanceId, stopping: this.stopping,
      capabilities: { context: 'local-curated', ...this.options.capabilities, apifyArtifact: !!this.options.apifyDocuments?.length }, limits: LIMITS,
      queued: [...this.jobs.values()].filter(j => j.status === 'queued').length,
      running: [...this.jobs.values()].filter(j => j.status === 'running' || j.status === 'cancelling').length };
  }
  private checkInstance(value: string) { if (value !== this.instanceId) fail(409, 'INSTANCE_CHANGED'); }
  private expire() {
    for (const job of this.jobs.values()) if (terminal(job) && job.expiresAt && Date.parse(job.expiresAt) <= this.now()) {
      this.jobs.delete(job.jobId); // Request tombstone remains: a stale retry cannot spend again.
    }
  }
  private view(job: Job) {
    const { input: _input, recipe: _recipe, binding: _binding, controller: _controller, ...view } = job;
    return structuredClone({ version: 1, instanceId: this.instanceId, ...view, nativeVerified: false, remoteComputationStopped: null });
  }
  submit(raw: unknown) {
    if (this.stopping) fail(503, 'SERVICE_STOPPING');
    let input: JobInput;
    try { input = submission.parse(raw); } catch { return fail(400, 'INVALID_JOB'); }
    this.checkInstance(input.instanceId);
    const digest = hash(input);
    const previous = this.requests.get(input.requestId);
    this.expire();
    if (previous) {
      if (previous.digest !== digest) fail(409, 'REQUEST_ID_CONFLICT');
      const job = this.jobs.get(previous.jobId);
      if (!job) return fail(410, 'JOB_EXPIRED');
      return this.view(job);
    }
    if (this.requests.size >= LIMITS.maxRequestsPerInstance) fail(429, 'INSTANCE_REQUEST_LIMIT');
    if (this.jobs.size >= LIMITS.maxRetained || [...this.jobs.values()].filter(j => j.status === 'queued').length >= LIMITS.maxQueued) fail(429, 'QUEUE_FULL');
    const job: Job = { jobId: randomUUID(), requestId: input.requestId, kind: input.kind, input,
      status: 'queued', createdAt: new Date(this.now()).toISOString(), controller: new AbortController() };
    try {
      if (input.kind === 'context') {
        input.source = validateServiceSource(input.source); assertRoute(input.source.sourceApp, input.target.appId);
        if (input.retrieval === 'moss' && !this.options.capabilities.moss) fail(503, 'PROVIDER_DISABLED');
        if (input.recipe === 'apify-reference' && !this.options.apifyDocuments?.length) fail(503, 'APIFY_ARTIFACT_UNAVAILABLE');
        job.recipe = input.recipe === 'apify-reference'
          ? apifyContextRecipe(this.options.apifyDocuments!, input.source, input.target)
          : selectContextRecipe(input.source, input.target, input.recipe);
        job.binding = { sourceHash: sourceFingerprint(input.source), target: input.target };
      } else if (input.kind === 'quiz') {
        input.input.source = validateServiceSource(input.input.source);
        if (!this.options.capabilities.quiz) fail(503, 'PROVIDER_DISABLED');
      } else {
        if (!this.options.capabilities.image) fail(503, 'PROVIDER_DISABLED');
        if (Buffer.from(input.imageBase64, 'base64').toString('base64') !== input.imageBase64) fail(400, 'INVALID_IMAGE_ENCODING');
      }
    } catch (error) { if (error instanceof ServiceError) throw error; return fail(400, 'INVALID_PREPARATION_INPUT'); }
    this.requests.set(input.requestId, { digest, jobId: job.jobId }); this.jobs.set(job.jobId, job);
    // Return the acceptance before work can complete; all jobs share a single slot.
    queueMicrotask(() => this.pump());
    return this.view(job);
  }
  get(jobId: string) {
    this.expire(); const job = this.jobs.get(jobId);
    if (!job) return fail(404, 'JOB_NOT_FOUND');
    return this.view(job);
  }
  cancel(jobId: string) {
    this.expire(); const job = this.jobs.get(jobId);
    if (!job) return fail(404, 'JOB_NOT_FOUND');
    if (job.code === 'WORKER_CLEANUP_UNKNOWN') return this.view(job);
    job.controller.abort(); delete job.result;
    if (job.status === 'running' || job.status === 'cancelling') job.status = 'cancelling';
    else this.finish(job, 'cancelled', 'CANCELLED');
    return this.view(job);
  }
  private finish(job: Job, status: Status, code?: string) {
    job.status = status; job.finishedAt = new Date(this.now()).toISOString();
    job.expiresAt = new Date(this.now() + LIMITS.retentionMs).toISOString();
    if (code) job.code = code;
    delete job.input; delete job.recipe;
  }
  private pump() {
    if (this.active || this.stopping) return;
    const job = [...this.jobs.values()].find(j => j.status === 'queued');
    if (!job) return;
    job.status = 'running';
    this.active = this.execute(job).finally(() => { this.active = undefined; this.pump(); });
  }
  private async execute(job: Job) {
    const input = job.input!;
    try {
      const worker = this.options.executeWorker ?? runPreparationWorker;
      const options = { signal: job.controller.signal, timeoutMs: LIMITS.jobMs, env: this.options.workerEnv };
      let result: unknown;
      if (input.kind === 'context') {
        const recipe = job.recipe!;
        const expected = prepareCuratedContext(recipe.documents, recipe.query);
        result = input.retrieval === 'local-curated' ? expected : await worker({ kind: 'context', ...recipe, retrieval: 'moss' }, options);
        const prepared = result as PreparedEvidence;
        new PreparedContextStore().put(prepared);
        if (hash(prepared.scope) !== hash(expected.scope) || prepared.query !== expected.query
          || prepared.corpusSha256 !== expected.corpusSha256 || prepared.retrieval !== input.retrieval) throw Error();
        for (const hit of prepared.evidence) {
          const canonical = recipe.documents.find(d => d.id === hit.document.id);
          if (!canonical || hash(canonical) !== hash(hit.document)) throw Error();
        }
      } else if (input.kind === 'quiz') {
        result = QuizResultSchema.parse(await worker({ kind: 'quiz', input: input.input }, options));
      } else {
        const extracted = await worker({ kind: 'image', imageBase64: input.imageBase64, source: input.source }, options) as Record<string, unknown>;
        parseImageObservations(extracted.observations);
        const source = extracted.source as Record<string, unknown>;
        if (extracted.provider !== 'bitdeer' || extracted.provenance !== 'inferred' || extracted.model !== 'zai-org/GLM-5.3-Flash'
          || hash({ ...source, sha256: undefined }) !== hash(input.source)
          || source.sha256 !== createHash('sha256').update(Buffer.from(input.imageBase64, 'base64')).digest('hex')) throw Error();
        result = extracted;
      }
      if (job.controller.signal.aborted || this.stopping) { this.finish(job, 'cancelled', 'CANCELLED'); return; }
      if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.resultBytes) throw Error();
      job.result = structuredClone(result); this.finish(job, 'succeeded');
    } catch (error) {
      const cleanupUnknown = error instanceof PreparationWorkerError && error.code === 'worker_cleanup_unknown';
      if (cleanupUnknown) {
        // Never start a second worker while a prior process group might still be alive.
        this.stopping = true;
        this.cleanupUnconfirmed = true;
        for (const pending of this.jobs.values()) if (pending.status === 'queued') {
          pending.controller.abort(); this.finish(pending, 'cancelled', 'SERVICE_STOPPING');
        }
      }
      const code = cleanupUnknown ? 'WORKER_CLEANUP_UNKNOWN'
        : error instanceof PreparationWorkerError && error.code === 'worker_timeout' ? 'PREPARATION_TIMEOUT'
        : error instanceof PreparationWorkerError && error.code === 'provider_unavailable' ? 'PROVIDER_UNAVAILABLE' : 'PREPARATION_FAILED';
      this.finish(job, cleanupUnknown ? 'failed' : job.controller.signal.aborted ? 'cancelled' : 'failed',
        cleanupUnknown ? code : job.controller.signal.aborted ? 'CANCELLED' : code);
    }
  }
  attach(raw: unknown): { version: 1; request: PlannerRequest } {
    const schema = z.strictObject({ version: z.literal(1), instanceId: z.string().uuid(), jobIds: z.array(z.string().uuid()).min(1).max(4), request: PlannerRequestSchema });
    let input: z.infer<typeof schema>;
    try { input = schema.parse(raw); validateRequest(input.request); } catch { return fail(400, 'INVALID_ATTACHMENT'); }
    this.checkInstance(input.instanceId); this.expire();
    if (new Set(input.jobIds).size !== input.jobIds.length) fail(400, 'DUPLICATE_JOB');
    const contexts: PreparedEvidence[] = [];
    for (const jobId of input.jobIds) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'succeeded' || job.kind !== 'context' || !job.result) return fail(409, 'CONTEXT_NOT_READY');
      if (job.binding?.sourceHash !== sourceFingerprint(input.request.source) || hash(job.binding.target) !== hash(input.request.target)) fail(409, 'CONTEXT_BINDING_MISMATCH');
      contexts.push(job.result as PreparedEvidence);
    }
    try { return { version: 1, request: attachPreparedEvidence(input.request, contexts, contexts.map(c => c.scope)) }; }
    catch { return fail(400, 'CONTEXT_ATTACHMENT_REJECTED'); }
  }
  async close() {
    this.stopping = true;
    for (const job of this.jobs.values()) if (!terminal(job)) this.cancel(job.jobId);
    await this.active;
    this.jobs.clear(); this.requests.clear();
    if (this.cleanupUnconfirmed) fail(503, 'WORKER_CLEANUP_UNKNOWN');
  }
}
