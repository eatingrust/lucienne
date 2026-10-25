import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { QuizResultSchema, QuizTurnSchema, SourceProfileSchema, type SourceProfile } from '../../../contracts/index.js';
import { getProfile, loadProfiles } from '../../../profiles/index.js';
import { nextQuizTurn, type QuizInput } from '../../../services/preparation/quiz.js';
import type { PreparationRuntime } from './preparation-runtime.js';
import type { PreparationJob } from '../../../services/preparation/client.js';

type Turn = z.infer<typeof QuizTurnSchema>;
type Result = z.infer<typeof QuizResultSchema>;
const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const startSchema = z.strictObject({ sourceProfileId: id, sourceRevision: id });
const identitySchema = startSchema.extend({ quizId: z.string().uuid(), requestId: z.string().uuid() });
const answerSchema = identitySchema.extend({ text: z.string().trim().min(1).max(2000) });
const acceptSchema = identitySchema.extend({ resultRevision: id });
export type QuizIdentity = z.infer<typeof identitySchema>;
export type QuizStart = z.infer<typeof startSchema>;
export type QuizAnswer = z.infer<typeof answerSchema>;
export type QuizAccept = z.infer<typeof acceptSchema>;
/** Host-owned state; structurally matches the renderer view without importing renderer code. */
export interface QuizViewState extends QuizIdentity {
  status: 'idle' | 'running' | 'question' | 'complete' | 'error' | 'cancelled';
  turns: Turn[]; result: Result | null; errorCode: string | null;
}
export type QuizPreparation = Pick<PreparationRuntime, 'submit' | 'get' | 'cancel'> & {
  snapshot(): { recoveryRequired: boolean };
};
export class QuizRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'QuizRuntimeError'; }
}
const fail = (code: string): never => { throw new QuizRuntimeError(code); };
const curatedIds = new Set(loadProfiles().map(profile => profile.profileId));
const jobSchema = z.object({ version: z.literal(1), instanceId: z.string().uuid(), jobId: z.string().uuid(), requestId: id,
  kind: z.literal('quiz'), status: z.enum(['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'expired']),
  nativeVerified: z.literal(false), remoteComputationStopped: z.null(), code: z.string().optional(), result: z.unknown().optional() });
type Pending = { controller: AbortController; input: QuizInput; task: Promise<void> };
type Context = { generation: number; source: SourceProfile; view: QuizViewState; userEvidence: QuizInput['userEvidence'];
  jobs: Set<string>; cancellations: Map<string, Promise<void>>; pending?: Pending; accepting: boolean };
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  return result.success ? result.data : fail('QUIZ_COMMAND_INVALID');
}
function boundedTurns(turns: Turn[]): Turn[] {
  if (turns.length > 48 || turns.reduce((total, turn) => total + turn.text.length, 0) > 16_000)
    return fail('QUIZ_TRANSCRIPT_LIMIT');
  return turns.map(turn => QuizTurnSchema.parse(turn));
}
function safeFailure(error: unknown): string {
  if (error instanceof QuizRuntimeError) return error.code;
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (['PREPARATION_RECOVERY_REQUIRED', 'SUBMISSION_OUTCOME_UNKNOWN', 'CLEANUP_UNCONFIRMED', 'WORKER_CLEANUP_UNKNOWN'].includes(String(code)))
    return 'QUIZ_RECOVERY_REQUIRED';
  if (code === 'PROVIDER_DISABLED') return 'QUIZ_PROVIDER_DISABLED';
  if (code === 'PREPARATION_TIMEOUT') return 'QUIZ_TIMEOUT';
  return 'QUIZ_PREPARATION_FAILED';
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new QuizRuntimeError('QUIZ_CANCELLED')); return; }
    const aborted = () => { clearTimeout(timer); reject(new QuizRuntimeError('QUIZ_CANCELLED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Setup proposals only. PreparationRuntime owns provider configuration (Claude Opus 5.5),
 * remote job ownership and cleanup. This controller never persists or applies a profile. */
export class QuizRuntime {
  private generation = 0;
  private active?: Context;
  private view: QuizViewState | null = null;
  private cleanup?: Promise<void>;
  private starting = false;
  private recovery = false;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  constructor(private readonly options: { preparation: QuizPreparation;
    lookupProfile?: (profileId: string) => SourceProfile; onState?: (state: QuizViewState | null) => void;
    isSessionActive?: () => boolean; pollIntervalMs?: number; timeoutMs?: number }) {
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.timeoutMs = options.timeoutMs ?? 125_000;
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs < 1 || this.pollIntervalMs > 5000 ||
        !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 180_000) fail('QUIZ_CONFIG_INVALID');
  }
  snapshot(): QuizViewState | null { return structuredClone(this.view); }
  get recoveryRequired(): boolean { return this.recovery; }
  private publish(): void { try { this.options.onState?.(this.snapshot()); } catch { /* Observers do not own lifecycle. */ } }
  private available(): void {
    if (this.options.preparation.snapshot().recoveryRequired) this.recovery = true;
    if (this.recovery) fail('QUIZ_RECOVERY_REQUIRED');
    if (this.cleanup || this.starting) fail('QUIZ_BUSY');
    if (this.options.isSessionActive?.()) fail('QUIZ_SESSION_ACTIVE');
  }
  private source(profileId: string, revision: string): SourceProfile {
    if (!curatedIds.has(profileId)) return fail('QUIZ_SOURCE_UNKNOWN');
    let source: SourceProfile;
    try { source = SourceProfileSchema.parse((this.options.lookupProfile ?? getProfile)(profileId)); }
    catch { return fail('QUIZ_SOURCE_UNKNOWN'); }
    if (source.profileId !== profileId || source.revision !== revision) return fail('QUIZ_SOURCE_STALE');
    return structuredClone(source);
  }
  private assertCurrent(ctx: Context): void {
    if (this.active !== ctx || ctx.generation !== this.generation) fail('QUIZ_STALE');
    if (this.options.isSessionActive?.()) fail('QUIZ_SESSION_ACTIVE');
  }
  private matches(raw: unknown, allowSession = false): Context {
    const input = parse(identitySchema, raw);
    const ctx = this.active;
    if (!ctx || Object.entries(input).some(([key, value]) => ctx.view[key as keyof QuizIdentity] !== value)) return fail('QUIZ_STALE');
    if (this.active !== ctx || ctx.generation !== this.generation) fail('QUIZ_STALE');
    if (!allowSession && this.options.isSessionActive?.()) fail('QUIZ_SESSION_ACTIVE');
    return ctx;
  }
  private assertSource(ctx: Context): void {
    if (!isDeepStrictEqual(this.source(ctx.source.profileId, ctx.source.revision), ctx.source)) fail('QUIZ_SOURCE_STALE');
  }
  async start(raw: QuizStart): Promise<void> {
    const input = parse(startSchema, raw); this.available();
    const source = this.source(input.sourceProfileId, input.sourceRevision);
    if (this.active && this.active.view.status !== 'error') fail('QUIZ_BUSY');
    this.starting = true;
    try {
      const reset = this.reset();
      const generation = this.generation;
      await reset;
      if (generation !== this.generation) fail('QUIZ_STALE');
      if (this.recovery) fail('QUIZ_RECOVERY_REQUIRED');
      if (this.options.isSessionActive?.()) fail('QUIZ_SESSION_ACTIVE');
      const ctx: Context = { generation, source, userEvidence: [], jobs: new Set(), cancellations: new Map(), accepting: false,
        view: { ...input, quizId: randomUUID(), requestId: randomUUID(), status: 'idle', turns: [], result: null, errorCode: null } };
      this.active = ctx;
      this.launch(ctx);
    } finally { this.starting = false; }
  }
  async answer(raw: QuizAnswer): Promise<void> {
    const { text, ...identity } = parse(answerSchema, raw); this.available();
    const ctx = this.matches(identity); this.assertSource(ctx);
    if (ctx.accepting || ctx.view.status !== 'question') fail('QUIZ_NOT_WAITING');
    const turn = QuizTurnSchema.parse({ version: 1, turnId: randomUUID(), role: 'user', text });
    const turns = boundedTurns([...ctx.view.turns, turn]);
    if (ctx.userEvidence.length >= 24) fail('QUIZ_TRANSCRIPT_LIMIT');
    ctx.view.turns = turns;
    ctx.userEvidence.push({ turnId: turn.turnId, evidenceRef: `quiz:user:${turn.turnId}` });
    this.launch(ctx);
  }
  private launch(ctx: Context): void {
    const requestId = randomUUID();
    ctx.view = { ...ctx.view, requestId, status: 'running', result: null, errorCode: null };
    const input: QuizInput = { source: structuredClone(ctx.source), turns: structuredClone(ctx.view.turns),
      userEvidence: structuredClone(ctx.userEvidence), nextRevision: `quiz:${requestId}`, invocationEvidenceRef: `quiz:invocation:${requestId}` };
    const pending: Pending = { controller: new AbortController(), input, task: Promise.resolve() };
    ctx.pending = pending; this.view = ctx.view;
    // Install the promise before publishing: a state observer may synchronously reset.
    pending.task = Promise.resolve().then(() => this.run(ctx, pending));
    this.publish();
  }
  private async run(ctx: Context, pending: Pending): Promise<void> {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; pending.controller.abort(); }, this.timeoutMs);
    const current = () => {
      this.assertCurrent(ctx);
      if (pending.controller.signal.aborted) fail(timedOut ? 'QUIZ_TIMEOUT' : 'QUIZ_CANCELLED');
    };
    try {
      current(); this.assertSource(ctx);
      let job = await this.options.preparation.submit({ kind: 'quiz', input: structuredClone(pending.input) }, pending.controller.signal);
      // Remember a late accepted job before checking generation so reset can dispose it.
      if (typeof job?.jobId === 'string' && z.string().uuid().safeParse(job.jobId).success) ctx.jobs.add(job.jobId);
      current();
      const accepted = parseJob(job);
      while (true) {
        current();
        const checked = parseJob(job);
        if (checked.jobId !== accepted.jobId || checked.instanceId !== accepted.instanceId || checked.requestId !== accepted.requestId)
          fail('QUIZ_JOB_MISMATCH');
        if (checked.status === 'succeeded') {
          const result = await this.validateResult(pending.input, checked.result, pending.controller.signal);
          current(); this.assertSource(ctx);
          if (result.status === 'continue') ctx.view.turns = boundedTurns([...ctx.view.turns,
            { version: 1, turnId: randomUUID(), role: 'assistant', text: result.question! }]);
          ctx.view.result = result; ctx.view.status = result.status === 'continue' ? 'question' : 'complete';
          this.view = ctx.view; this.publish(); return;
        }
        if (!['queued', 'running'].includes(checked.status)) {
          if (checked.code === 'WORKER_CLEANUP_UNKNOWN') fail('QUIZ_RECOVERY_REQUIRED');
          fail(checked.code === 'PREPARATION_TIMEOUT' ? 'QUIZ_TIMEOUT' : 'QUIZ_PREPARATION_FAILED');
        }
        await pause(this.pollIntervalMs, pending.controller.signal); current();
        job = await this.options.preparation.get(accepted.jobId, pending.controller.signal);
      }
    } catch (error) {
      if (this.active !== ctx || ctx.generation !== this.generation) return;
      const code = timedOut ? 'QUIZ_TIMEOUT' : safeFailure(error);
      if (code === 'QUIZ_RECOVERY_REQUIRED' || this.options.preparation.snapshot().recoveryRequired) this.recovery = true;
      try { await this.cleanupJobs(ctx); } catch { this.recovery = true; }
      if (this.active !== ctx || ctx.generation !== this.generation) return;
      ctx.view = { ...ctx.view, status: 'error', result: null, errorCode: this.recovery ? 'QUIZ_RECOVERY_REQUIRED' : code };
      this.view = ctx.view; this.publish();
    } finally { clearTimeout(timer); }
  }
  private async validateResult(input: QuizInput, raw: unknown, signal: AbortSignal): Promise<Result> {
    // Reuse profile service's semantic checks with the received value. No transport/provider is invoked.
    try { return await nextQuizTurn({ provider: 'claude', mode: 'live', next: async () => raw }, structuredClone(input), signal); }
    catch { return fail('QUIZ_RESULT_INVALID'); }
  }
  private async cleanupJobs(ctx: Context): Promise<void> {
    const results = await Promise.allSettled([...ctx.jobs].map(jobId => {
      let task = ctx.cancellations.get(jobId);
      if (!task) {
        task = Promise.resolve().then(() => this.options.preparation.cancel(jobId));
        ctx.cancellations.set(jobId, task);
      }
      return task;
    }));
    if (results.some(result => result.status === 'rejected')) { this.recovery = true; fail('QUIZ_RECOVERY_REQUIRED'); }
  }
  private dispose(ctx?: Context): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.cleanup = Promise.resolve().then(async () => {
      await ctx?.pending?.task;
      if (ctx) await this.cleanupJobs(ctx);
      if (this.options.preparation.snapshot().recoveryRequired) this.recovery = true;
      if (this.recovery) fail('QUIZ_RECOVERY_REQUIRED');
    }).finally(() => { this.cleanup = undefined; });
    return this.cleanup;
  }
  async cancel(raw: QuizIdentity): Promise<void> {
    const ctx = this.matches(raw, true);
    this.generation++; this.active = undefined; ctx.pending?.controller.abort();
    this.view = { ...ctx.view, status: 'cancelled', turns: [], result: null, errorCode: null };
    const cleanup = this.dispose(ctx); this.publish();
    const generation = this.generation;
    try { await cleanup; }
    catch {
      if (generation === this.generation && this.view) { this.view.status = 'error'; this.view.errorCode = 'QUIZ_RECOVERY_REQUIRED'; this.publish(); }
      fail('QUIZ_RECOVERY_REQUIRED');
    }
  }
  reset(): Promise<void> {
    this.generation++; const ctx = this.active; this.active = undefined;
    ctx?.pending?.controller.abort(); this.view = null;
    const cleanup = this.dispose(ctx); this.publish();
    return cleanup;
  }
  async accept(raw: QuizAccept): Promise<SourceProfile> {
    const { resultRevision, ...identity } = parse(acceptSchema, raw); this.available();
    const ctx = this.matches(identity); this.assertSource(ctx);
    if (ctx.accepting || ctx.view.status !== 'complete' || !ctx.pending || ctx.view.result?.status !== 'complete' ||
        ctx.view.result.profile?.revision !== resultRevision) return fail('QUIZ_RESULT_NOT_ACCEPTABLE');
    ctx.accepting = true;
    try {
      const result = await this.validateResult(ctx.pending.input, ctx.view.result, ctx.pending.controller.signal);
      this.assertCurrent(ctx); this.assertSource(ctx);
      await this.cleanupJobs(ctx);
      this.assertCurrent(ctx); this.assertSource(ctx);
      const proposal = SourceProfileSchema.parse(result.profile);
      this.generation++; this.active = undefined; ctx.pending.controller.abort(); this.view = null; this.publish();
      return structuredClone(proposal);
    } catch (error) {
      if (this.recovery && this.active === ctx) {
        ctx.view = { ...ctx.view, status: 'error', result: null, errorCode: 'QUIZ_RECOVERY_REQUIRED' };
        this.view = ctx.view; this.publish();
      }
      throw error;
    } finally { ctx.accepting = false; }
  }
}
function parseJob(raw: PreparationJob): z.infer<typeof jobSchema> {
  try { return jobSchema.parse(raw); } catch { return fail('QUIZ_JOB_INVALID'); }
}
