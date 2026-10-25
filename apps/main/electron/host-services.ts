import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { PlannerRequest, RunEvent, SourceProfile } from '../../../contracts/index.js';
import type { RuntimeServices, RuntimeQuiz } from '../../../contracts/bridge.js';
import type { Selection } from '../../../core/session.js';
import type { PreparationPort } from '../../../services/preparation/client.js';
import { PreparationRuntime, readPreparationRuntimeConfig } from './preparation-runtime.js';
import { createSessionRuntime, type MainSessionRuntime, type SessionRuntimeDependencies } from './session-runtime.js';
import { QuizRuntime, type QuizStart, type QuizAnswer, type QuizIdentity, type QuizAccept } from './quiz-runtime.js';
import { getProfile, loadProfiles } from '../../../profiles/index.js';

type ClientModule = typeof import('../../../services/preparation/client.js');
type ConfigModule = typeof import('../../../services/preparation/server/config.js');
type ArtifactModule = typeof import('../../../services/preparation/server/apify-artifact.js');
export interface PreparationModules {
  createLocalPreparationClient: ClientModule['createLocalPreparationClient'];
  createHttpPreparationClient: ClientModule['createHttpPreparationClient'];
  readPreparationProviderConfig: ConfigModule['readPreparationProviderConfig'];
  loadApifyArtifact: ArtifactModule['loadApifyArtifact'];
}
export interface HostSelection { runId: string; selection: Selection }
type ContextView = RuntimeServices['preparation']['context'];
type ContextRecipe = NonNullable<ContextView['recipe']>;
type Retrieval = NonNullable<ContextView['retrieval']>;
type AcceptedContext = { jobId: string; binding: HostSelection };
export interface HostServicesOptions {
  userData: string;
  /** Fixed built directory supplied by main, never an IPC argument. */
  preparationDirectory: string;
  environment?: NodeJS.ProcessEnv;
  /** Explicit fixture mode avoids reading host credentials or starting a session transport. */
  fixture?: boolean;
  selected(): HostSelection | undefined;
  /** Includes selection/preflight, reset, QA and quit guards as well as an active session. */
  isSessionActive?(): boolean;
  /** Rebuilds main's finite registry before accepted visitor profiles are published. */
  onAcceptedProfiles?(profiles: SourceProfile[]): void;
  onStatus?(): void;
}
export interface HostServicesDependencies {
  session?: SessionRuntimeDependencies;
  loadPreparation?: () => Promise<PreparationModules>;
  /** Trusted timer seam only; retry timing is never renderer-controlled. */
  sessionRetry?: { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}
const sessionRetryClock: NonNullable<HostServicesDependencies['sessionRetry']> = {
  setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timer.unref(); return timer; },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const codeOf = (cause: unknown) => {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'PREPARATION_UNAVAILABLE';
};
const emptyContext = (): ContextView => ({ status: 'none', recipe: null, retrieval: null, evidenceCount: 0 });

/** Dynamic ESM sidecars preserve the preparation worker's import.meta.url. */
export async function loadPreparationSidecar(directory: string): Promise<PreparationModules> {
  if (!path.isAbsolute(directory)) return fail('PREPARATION_CONFIG_INVALID');
  const [client, config, artifact]: [ClientModule, ConfigModule, ArtifactModule] = await Promise.all([
    import(pathToFileURL(path.join(directory, 'client.js')).href),
    import(pathToFileURL(path.join(directory, 'server/config.js')).href),
    import(pathToFileURL(path.join(directory, 'server/apify-artifact.js')).href),
  ]);
  return { createLocalPreparationClient: client.createLocalPreparationClient,
    createHttpPreparationClient: client.createHttpPreparationClient,
    readPreparationProviderConfig: config.readPreparationProviderConfig, loadApifyArtifact: artifact.loadApifyArtifact };
}

/** Main-only service ownership. Native reset is started before any service cleanup is awaited. */
export class HostServices {
  private readonly session?: MainSessionRuntime;
  private sessionRetryTimer?: { handle?: unknown };
  private sessionRetryActive = false;
  private sessionRetryDelay = 1000;
  private preparation?: PreparationRuntime;
  private initializePromise?: Promise<void>;
  private resetPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closing = false;
  private closed = false;
  private generation = 0;
  private contextController?: AbortController;
  private accepted?: AcceptedContext;
  private quiz?: QuizRuntime;
  private acceptedProfiles = new Map<string, SourceProfile>();
  private view: RuntimeServices['preparation'] = {
    status: 'starting', mode: 'local', busy: false, recoveryRequired: false, code: null,
    capabilities: { context: 'local-curated', moss: false, quiz: false, image: false, apifyArtifact: false },
    context: emptyContext(),
  };
  constructor(private readonly options: HostServicesOptions, private readonly dependencies: HostServicesDependencies = {}) {
    if (!options.fixture) this.session = createSessionRuntime({ userData: options.userData,
      env: options.environment, onStatus: () => { this.updateSessionRetry(); this.notify(); } }, dependencies.session);
  }
  private notify(): void { try { this.options.onStatus?.(); } catch { /* Observers cannot own lifecycle. */ } }
  private cancelSessionRetry(): void {
    const timer = this.sessionRetryTimer; this.sessionRetryTimer = undefined;
    if (timer) (this.dependencies.sessionRetry ?? sessionRetryClock).clearTimeout(timer.handle);
  }
  private updateSessionRetry(): void {
    const session = this.session;
    if (this.closing || this.closed || !session || session.snapshot().status !== 'offline') {
      this.cancelSessionRetry(); this.sessionRetryDelay = 1000; return;
    }
    if (this.sessionRetryTimer || this.sessionRetryActive) return;
    const timer: { handle?: unknown } = {};
    this.sessionRetryTimer = timer;
    timer.handle = (this.dependencies.sessionRetry ?? sessionRetryClock).setTimeout(() => {
      // Clearing a timer is not enough if its callback was already queued.
      if (this.sessionRetryTimer !== timer) return;
      this.sessionRetryTimer = undefined;
      if (this.closing || this.closed || session.snapshot().status !== 'offline') return;
      this.sessionRetryActive = true;
      this.sessionRetryDelay = Math.min(this.sessionRetryDelay * 2, 30_000);
      // Same runtime/publisher retains its persisted identity, stream and queued cursors.
      // No local operation awaits this optional network work, including reset and close.
      void session.resume().catch(() => {}).finally(() => {
        this.sessionRetryActive = false;
        this.updateSessionRetry();
      });
    }, this.sessionRetryDelay);
  }
  snapshot(): RuntimeServices {
    const runtime = this.preparation?.snapshot();
    return structuredClone({ session: this.session?.snapshot() ?? { status: this.closed ? 'closed' : 'disabled', queued: 0 },
      preparation: { ...this.view, busy: !!this.contextController || !!this.resetPromise || !!this.closePromise || !!runtime?.busy,
        recoveryRequired: !!runtime?.recoveryRequired,
        status: runtime?.recoveryRequired ? 'recovery-required' : this.closed ? 'closed' : this.view.status } });
  }
  quizSnapshot(): RuntimeQuiz {
    const recoveryRequired = !!this.quiz?.recoveryRequired || !!this.preparation?.snapshot().recoveryRequired;
    return { available: !!this.quiz && this.view.status === 'available' && this.view.capabilities.quiz &&
        !this.closing && !this.closed && !this.resetPromise && !recoveryRequired,
      recoveryRequired,
      resetKey: this.generation, state: this.resetPromise || this.closing || this.closed ? null : this.quiz?.snapshot() ?? null };
  }
  acceptedQuizProfiles(): SourceProfile[] { return structuredClone([...this.acceptedProfiles.values()]); }
  profiles(): SourceProfile[] { return loadProfiles().map(profile => structuredClone(this.acceptedProfiles.get(profile.profileId) ?? profile)); }
  initialize(trustedClaude: { apiKey?: string; workspaceId?: string } = {}): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      // Session initialization reads local protected configuration only, never waits for the network.
      await this.session?.initialize();
      if (this.closing || this.closed) return;
      try {
        const environment = this.options.fixture ? {} : { ...(this.options.environment ?? process.env) };
        if (!this.options.fixture && (environment.LUCIENNE_PREPARATION_MODE ?? 'local') === 'local'
          && environment.LUCIENNE_PREPARATION_QUIZ === undefined && (environment.ANTHROPIC_API_KEY || trustedClaude.apiKey)) {
          environment.LUCIENNE_PREPARATION_QUIZ = '1';
        }
        if (environment.LUCIENNE_PREPARATION_QUIZ === '1' && !environment.ANTHROPIC_API_KEY && trustedClaude.apiKey) {
          environment.ANTHROPIC_API_KEY = trustedClaude.apiKey;
          if (trustedClaude.workspaceId) environment.ANTHROPIC_WORKSPACE_ID = trustedClaude.workspaceId;
        }
        const config = readPreparationRuntimeConfig(environment);
        this.view.mode = config.mode;
        this.view.capabilities = { context: 'local-curated', ...config.capabilities, apifyArtifact: false };
        const modules = await (this.dependencies.loadPreparation?.() ?? loadPreparationSidecar(this.options.preparationDirectory));
        if (this.closing || this.closed) return;
        if (config.mode === 'local') modules.readPreparationProviderConfig(config.environment);
        this.preparation = new PreparationRuntime({ config, isSessionActive: () => !!this.options.selected(),
          createPort(current): PreparationPort {
            if (current.mode === 'hosted') return modules.createHttpPreparationClient({ baseUrl: current.endpoint!, token: current.token! });
            const provider = modules.readPreparationProviderConfig(current.environment);
            return modules.createLocalPreparationClient({ capabilities: provider.capabilities, workerEnv: provider.workerEnv,
              apifyDocuments: provider.apifyArtifact ? modules.loadApifyArtifact(provider.apifyArtifact.path, provider.apifyArtifact.sha256) : undefined });
          } });
        this.quiz = new QuizRuntime({ preparation: this.preparationRuntime()!,
          lookupProfile: profileId => structuredClone(this.acceptedProfiles.get(profileId) ?? getProfile(profileId)),
          isSessionActive: () => this.closing || this.closed || !!this.resetPromise ||
            (this.options.isSessionActive?.() ?? !!this.options.selected()),
          onState: () => this.notify() });
        this.view.status = 'available'; this.view.code = null;
      } catch (cause) { this.view.status = 'unavailable'; this.view.code = codeOf(cause); }
      this.notify();
    })();
    return this.initializePromise;
  }
  trackEvent(event: RunEvent): void {
    this.session?.enqueue(event);
    // Non-mutating planner failures leave the coordinator selected/ready for retry,
    // so its accepted source must remain in the catalog. Native partial-write
    // failures also emit reset-started, which clears the full visitor profile.
    if (event.type === 'reset-started') void this.resetPreparation().catch(() => {});
    else if (event.type === 'failed') void this.cancelPreparation().catch(() => {});
  }
  /** Main-only pairing remains private; no command or renderer state exposes this capability. */
  issuePairing() { if (!this.session) return Promise.reject(new Error('SESSION_PAIRING_UNAVAILABLE')); return this.session.issuePairing(); }
  /** Trusted quiz host may reuse the same lifetime owner; never expose the runtime over IPC. */
  preparationRuntime(): PreparationRuntime | undefined { return this.preparation; }
  private quizRuntime(): QuizRuntime {
    this.runtime();
    if (!this.quiz || !this.view.capabilities.quiz) return fail('QUIZ_PROVIDER_DISABLED');
    return this.quiz;
  }
  startQuiz(input: QuizStart): Promise<void> { return this.quizRuntime().start(input); }
  answerQuiz(input: QuizAnswer): Promise<void> { return this.quizRuntime().answer(input); }
  cancelQuiz(input: QuizIdentity): Promise<void> { return this.quizRuntime().cancel(input); }
  async acceptQuiz(input: QuizAccept): Promise<void> {
    const generation = this.generation;
    const profile = await this.quizRuntime().accept(input);
    const current = () => generation === this.generation && !this.closing && !this.closed && !this.resetPromise &&
      !(this.options.isSessionActive?.() ?? !!this.options.selected());
    if (!current()) return fail('QUIZ_STALE');
    const accepted = new Map(this.acceptedProfiles); accepted.set(profile.profileId, structuredClone(profile));
    this.options.onAcceptedProfiles?.(structuredClone([...accepted.values()]));
    if (!current()) {
      this.options.onAcceptedProfiles?.(this.acceptedQuizProfiles());
      return fail('QUIZ_STALE');
    }
    this.acceptedProfiles = accepted; this.notify();
  }
  /** Selecting a case ends setup conversation without discarding an explicitly accepted profile. */
  async prepareSelection(): Promise<void> {
    if (this.closing || this.closed || this.resetPromise) return fail('PREPARATION_BUSY');
    this.generation++;
    try { await this.quiz?.reset(); }
    finally { this.notify(); }
  }
  private runtime(): PreparationRuntime {
    if (this.closing || this.closed) return fail('PREPARATION_CLOSED');
    if (!this.preparation) return fail('PREPARATION_UNAVAILABLE');
    return this.preparation;
  }
  async refreshPreparation(): Promise<void> {
    try {
      const status = await this.runtime().status();
      this.view.capabilities = status.capabilities; this.view.status = 'available'; this.view.code = null;
    } catch (cause) { this.view.code = codeOf(cause); this.view.status = 'unavailable'; throw cause; }
    finally { this.notify(); }
  }
  private current(binding: HostSelection, generation: number): boolean {
    return !this.closing && !this.closed && generation === this.generation && isDeepStrictEqual(this.options.selected(), binding);
  }
  async prepareContext(recipe: ContextRecipe, retrieval: Retrieval): Promise<void> {
    const runtime = this.runtime();
    if (this.contextController || this.resetPromise || this.accepted) return fail('PREPARATION_BUSY');
    const binding = structuredClone(this.options.selected());
    if (!binding) return fail('PREPARATION_SELECTION_REQUIRED');
    const generation = this.generation, controller = new AbortController();
    this.contextController = controller;
    this.view.context = { status: 'preparing', recipe, retrieval, evidenceCount: 0 }; this.view.code = null; this.notify();
    let jobId: string | undefined;
    try {
      let job = await runtime.submit({ kind: 'context', source: binding.selection.source, target: binding.selection.target,
        recipe, retrieval }, controller.signal);
      jobId = job.jobId;
      const deadline = Date.now() + 125_000;
      while (['queued', 'running', 'cancelling'].includes(job.status)) {
        if (!this.current(binding, generation) || controller.signal.aborted) return fail('PREPARATION_ABORTED');
        if (Date.now() >= deadline) return fail('PREPARATION_TIMEOUT');
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(Object.assign(new Error('PREPARATION_ABORTED'), { code: 'PREPARATION_ABORTED' })); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 40);
          controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort();
        });
        job = await runtime.get(job.jobId, controller.signal);
      }
      if (!this.current(binding, generation) || controller.signal.aborted) return fail('PREPARATION_ABORTED');
      if (job.status !== 'succeeded') return fail(job.code ?? 'PREPARATION_FAILED');
      this.accepted = { jobId: job.jobId, binding };
      const evidence = job.result && typeof job.result === 'object' && 'evidence' in job.result ? job.result.evidence : undefined;
      this.view.context = { status: 'ready', recipe, retrieval, evidenceCount: Array.isArray(evidence) ? evidence.length : 0 };
      this.view.status = 'available';
    } catch (cause) {
      if (jobId && generation === this.generation) {
        try { await runtime.cancel(jobId); } catch { /* The runtime retains cleanup uncertainty. */ }
      }
      if (generation === this.generation) { this.view.context.status = 'failed'; this.view.code = codeOf(cause); }
      throw cause;
    } finally {
      if (this.contextController === controller) this.contextController = undefined;
      this.notify();
    }
  }
  /** Passed only to SessionCoordinator's trusted initial-request preparation hook. */
  async prepareInitialRequest(request: PlannerRequest, signal: AbortSignal): Promise<PlannerRequest> {
    if (this.view.context.status === 'none') return request;
    if (!this.accepted || this.view.context.status !== 'ready') return fail('PREPARATION_CONTEXT_NOT_READY');
    const accepted = this.accepted, generation = this.generation;
    if (request.kind !== 'translate' || request.runId !== accepted.binding.runId
      || request.scenarioId !== accepted.binding.selection.scenarioId
      || !isDeepStrictEqual(request.source, accepted.binding.selection.source)
      || !isDeepStrictEqual(request.target, accepted.binding.selection.target)) return fail('CONTEXT_BINDING_MISMATCH');
    const attached = await this.runtime().attach([accepted.jobId], request, signal);
    if (signal.aborted || generation !== this.generation || this.accepted !== accepted || this.closing) return fail('PREPARATION_ABORTED');
    return attached;
  }
  /** Cancels optional work without changing the accepted profile of a selected session. */
  cancelPreparation(): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    this.generation++; this.contextController?.abort(); this.accepted = undefined; this.view.context = emptyContext();
    // Install the latch before callbacks can reenter; native cleanup never awaits this operation.
    this.resetPromise = Promise.resolve().then(async () => {
      // Quiz retains job IDs until its cleanup settles. Revoke preparation only after that drain.
      const quizResult = await Promise.allSettled([this.quiz?.reset()]);
      const preparationResult = await Promise.allSettled([this.preparation?.reset()]);
      for (const result of [...quizResult, ...preparationResult]) if (result.status === 'rejected') throw result.reason;
    }).then(() => {
      this.view.code = null;
    }, cause => { this.view.code = codeOf(cause); throw cause; }).finally(() => { this.resetPromise = undefined; this.notify(); });
    this.notify(); return this.resetPromise;
  }
  /** Full visitor reset also clears accepted profiles, even during an earlier cancellation. */
  resetPreparation(): Promise<void> {
    if (this.resetPromise) this.generation++; // A real reset remains a distinct UI/acceptance boundary.
    let profileFailure: unknown;
    if (this.acceptedProfiles.size) {
      this.acceptedProfiles.clear();
      try { this.options.onAcceptedProfiles?.([]); } catch (cause) { profileFailure = cause; }
    }
    const cleanup = this.cancelPreparation();
    if (!profileFailure) return cleanup;
    return cleanup.then(() => {
      this.view.code = codeOf(profileFailure); this.notify(); throw profileFailure;
    });
  }
  async reset(localReset: () => Promise<void>): Promise<void> {
    let local: Promise<void>;
    try { local = localReset(); } catch (cause) { local = Promise.reject(cause); }
    const results = await Promise.allSettled([local, this.resetPreparation()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.closed) return Promise.resolve();
    this.closing = true; this.generation++; this.contextController?.abort(); this.accepted = undefined; this.view.context = emptyContext();
    this.cancelSessionRetry();
    // Session transport closes immediately even if preparation cleanup subsequently fails.
    const sessionClose = this.session?.close() ?? Promise.resolve();
    this.closePromise = Promise.resolve().then(async () => {
      const reset = await Promise.allSettled([this.resetPreparation()]);
      const results = [...reset, ...await Promise.allSettled([sessionClose, this.preparation?.close()])];
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') { this.view.code = codeOf(failure.reason); throw failure.reason; }
      this.closed = true; this.view.status = 'closed';
    }).finally(() => { this.closePromise = undefined; this.notify(); });
    return this.closePromise;
  }
}
