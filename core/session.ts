import { isDeepStrictEqual } from 'node:util';
import {
  PlannerResultSchema, SourceProfileSchema, TargetSchema, RunEventSchema, validatePatch, validateRequest,
  type SourceProfile, type Target, type PlannerRequest, type Operation, type Phase,
  type RunEvent, type Provenance, type ChatIntent,
} from '../contracts/index.js';
import { NativeReadbackSchema, NativeResetResultSchema, DesktopResultSchema, type NativeAdapter, type PlannerPort, type DesktopPort, type CommitContext } from '../contracts/ports.js';
import { publicRunPresentation } from './presentation.js';

export interface Clock { now(): number; iso(): string }
/** Trusted main-process attachment only; never supplied by renderer or planner output. */
export type InitialRequestPreparer = (request: PlannerRequest, signal: AbortSignal) => Promise<PlannerRequest>;
const systemClock: Clock = { now: () => performance.now(), iso: () => new Date().toISOString() };
export interface Selection {
  scenarioId: string; source: SourceProfile; target: Target; explicit?: PlannerRequest['explicit'];
  /** Trusted host/scenario evidence and exact binding policy, never renderer/model supplied. */
  evidenceRefs?: PlannerRequest['evidenceRefs'];
  bindingApplicability?: PlannerRequest['bindingApplicability'];
}
export interface CommittedPatchMetadata {
  runId: string; requestId: string; generation: number; limitations: string[];
}
export interface SessionSnapshot {
  phase: Phase; runId: string | null; scenarioId: string | null; target: Target | null;
  remainingMs: number; closingRemainingMs: number; busy: boolean;
  evidenceKind: 'native' | 'fixture' | 'none'; lastError: string | null;
  /** Last verified commit in this active session, not proof that a pending change succeeded. */
  committedPatch: CommittedPatchMetadata | null;
}
interface Active {
  runId: string; selection: Selection; adapter: NativeAdapter; explicit: PlannerRequest['explicit'];
  operations: Operation[]; provenance: Provenance; sequence: number; committedPatch: CommittedPatchMetadata | null;
}
interface Pending { controller: AbortController; generation: number; request: PlannerRequest }
const fail = (code: string) => Object.assign(new Error(code), { code });
const codeOf = (cause: unknown) => cause instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(cause.message) ? cause.message : 'OPERATION_FAILED';
function validatePreparedRequest(original: PlannerRequest, raw: unknown): PlannerRequest {
  try {
    const prepared = validateRequest(raw);
    const immutable = ({ instruction: _instruction, evidenceRefs: _evidenceRefs, ...rest }: PlannerRequest) => rest;
    if (!isDeepStrictEqual(immutable(original), immutable(prepared))
        || (original.instruction && prepared.instruction !== original.instruction
          && !prepared.instruction.startsWith(`${original.instruction}\n`))
        || prepared.evidenceRefs.length < original.evidenceRefs.length
        || original.evidenceRefs.some((ref, index) => prepared.evidenceRefs[index] !== ref)
        || new Set(prepared.evidenceRefs).size !== prepared.evidenceRefs.length) throw Error();
    return prepared;
  } catch { throw fail('PREPARATION_REQUEST_INVALID'); }
}

/** Local authority. No network publisher or renderer clock is needed to finish/reset. */
export class SessionCoordinator {
  private phase: Phase = 'idle';
  private active: Active | null = null;
  private recovery: Active | null = null;
  private generation = 0;
  private pending: Pending | null = null;
  private nativeLane: Promise<unknown> = Promise.resolve();
  private resetPromise: Promise<void> | null = null;
  private explorationDeadline: number | null = null;
  private closingDeadline: number | null = null;
  private remaining = 60_000;
  private lastError: string | null = null;
  private requestSequence = 0;
  private readonly clock: Clock;
  private readonly id: () => string;
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();

  constructor(private readonly options: {
    desktop: DesktopPort; clock?: Clock; id?: () => string;
    onEvent?: (event: RunEvent) => void; plannerTimeoutMs?: number;
  }) {
    this.clock = options.clock ?? systemClock;
    this.id = options.id ?? (() => crypto.randomUUID());
    if (options.plannerTimeoutMs !== undefined && (!Number.isFinite(options.plannerTimeoutMs) || options.plannerTimeoutMs <= 0)) throw fail('INVALID_TIMEOUT');
  }
  snapshot(): SessionSnapshot {
    return { phase: this.phase, runId: this.active?.runId ?? null, scenarioId: this.active?.selection.scenarioId ?? null,
      target: this.active ? structuredClone(this.active.selection.target) : null,
      remainingMs: this.explorationDeadline === null ? this.remaining : Math.max(0, this.explorationDeadline - this.clock.now()),
      closingRemainingMs: this.closingDeadline === null ? 0 : Math.max(0, this.closingDeadline - this.clock.now()),
      busy: !!this.pending || this.phase === 'resetting', evidenceKind: this.active?.adapter.evidenceKind ?? 'none', lastError: this.lastError,
      committedPatch: this.active?.committedPatch ? structuredClone(this.active.committedPatch) : null };
  }
  /** Trusted host-only access for target-specific chat; values exist only after verified commit. */
  committedOperations(): Operation[] { return structuredClone(this.active?.operations ?? []); }
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Observer isolation. */ } }
  }
  private emit(active: Active, type: RunEvent['type'], requestId: string | null = null, evidenceRefs: string[] = [], code?: string,
    plannedOperations?: readonly Operation[]): void {
    const presentation = publicRunPresentation({ type, source: active.selection.source, target: active.selection.target.appId,
      mode: active.provenance.mode, evidenceKind: active.adapter.evidenceKind, catalog: active.adapter.catalog,
      explicit: this.pending?.request.explicit ?? active.explicit, operations: plannedOperations ?? active.operations });
    const event = RunEventSchema.parse({ version: 1, eventId: `${active.runId}:${++active.sequence}`,
      runId: active.runId, requestId, scenarioId: active.selection.scenarioId, sequence: active.sequence,
      generation: this.generation, at: this.clock.iso(), monotonicMs: Math.max(0, this.clock.now()),
      type, phase: this.phase, target: active.selection.target, mode: active.provenance.mode,
      provider: active.provenance.provider, evidenceKind: active.adapter.evidenceKind,
      remainingMs: this.snapshot().remainingMs, evidenceRefs: [...new Set(evidenceRefs)].slice(0, 32), ...(code ? { code } : {}),
      ...(presentation ? { presentation } : {}) });
    try { this.options.onEvent?.(structuredClone(event)); } catch { /* Offline telemetry cannot interrupt local lifecycle. */ }
    this.changed();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.nativeLane.then(work);
    this.nativeLane = result.catch(() => undefined);
    return result;
  }
  select(input: Selection, adapter: NativeAdapter): SessionSnapshot {
    if (this.phase !== 'idle' || this.resetPromise || this.recovery) throw fail('RESET_REQUIRED');
    const selection: Selection = { ...structuredClone(input), source: SourceProfileSchema.parse(input.source), target: TargetSchema.parse(input.target) };
    if (selection.bindingApplicability && !selection.evidenceRefs) throw fail('BINDING_APPLICABILITY_EVIDENCE_REQUIRED');
    if (selection.target.appId !== adapter.target.appId || selection.target.adapterVersion !== adapter.target.adapterVersion) throw fail('WRONG_ADAPTER');
    const active: Active = { runId: this.id(), selection, adapter, explicit: selection.explicit ?? [], operations: [],
      provenance: { mode: 'prepared', provider: 'none', evidenceRefs: selection.source.evidenceRefs }, sequence: 0, committedPatch: null };
    // Validate the route and host-owned catalog before holding any visitor state.
    this.request(active, 'translate');
    this.active = active; this.generation++; this.phase = 'selected'; this.remaining = 60_000;
    this.lastError = null; this.explorationDeadline = null; this.closingDeadline = null;
    this.emit(active, 'selected'); return this.snapshot();
  }
  private request(active: Active, kind: 'translate' | 'chat', chat?: { intent: ChatIntent; instruction: string; explicit?: PlannerRequest['explicit'] }): PlannerRequest {
    const explicit = new Map(active.explicit.map(p => [p.key, p.value]));
    chat?.explicit?.forEach(p => explicit.set(p.key, p.value));
    return validateRequest({ version: 1, runId: active.runId, requestId: `${active.runId}:request-${++this.requestSequence}`,
      scenarioId: active.selection.scenarioId, kind, target: active.selection.target, source: active.selection.source,
      explicit: [...explicit].map(([key, value]) => ({ key, value })), instruction: chat?.instruction ?? '',
      ...(chat ? { intent: chat.intent } : {}), catalog: structuredClone([...active.adapter.catalog]),
      currentOperations: structuredClone(active.operations),
      evidenceRefs: active.selection.evidenceRefs ?? active.selection.source.evidenceRefs,
      ...(active.selection.bindingApplicability ? { bindingApplicability: active.selection.bindingApplicability } : {}) });
  }
  async translate(planner: PlannerPort, prepareRequest?: InitialRequestPreparer): Promise<void> {
    if (this.phase !== 'selected' || !this.active || this.pending) throw fail('INVALID_STATE');
    return this.execute(planner, this.request(this.active, 'translate'), prepareRequest);
  }
  openChat(): void {
    this.tick();
    if (this.phase !== 'ready' || !this.active || this.pending) throw fail('INVALID_STATE');
    this.remaining = this.snapshot().remainingMs; this.explorationDeadline = null; this.phase = 'chat';
    this.emit(this.active, 'chat-opened');
  }
  async chat(planner: PlannerPort, input: { intent: ChatIntent; instruction: string; explicit?: PlannerRequest['explicit'] }): Promise<void> {
    if (this.phase !== 'chat' || !this.active || this.pending) throw fail('INVALID_STATE');
    return this.execute(planner, this.request(this.active, 'chat', input));
  }
  closeChat(): void {
    if (this.phase !== 'chat' || !this.active || this.pending) throw fail('INVALID_STATE');
    this.phase = 'ready'; this.explorationDeadline = this.clock.now() + this.remaining;
    this.emit(this.active, 'chat-closed');
  }
  private current(pending: Pending, active: Active): boolean {
    return this.pending === pending && this.generation === pending.generation && this.active === active && !pending.controller.signal.aborted;
  }
  private async execute(planner: PlannerPort, request: PlannerRequest, prepareRequest?: InitialRequestPreparer): Promise<void> {
    const active = this.active!;
    const pending: Pending = { controller: new AbortController(), generation: this.generation, request };
    this.pending = pending;
    this.phase = request.kind === 'chat' ? 'chat' : 'planning';
    this.lastError = null;
    active.provenance = { mode: planner.mode, provider: planner.provider, evidenceRefs: request.evidenceRefs };
    const context: CommitContext = { runId: active.runId, requestId: request.requestId,
      generation: pending.generation, signal: pending.controller.signal, isCurrent: () => this.current(pending, active) };
    const assertCurrent = () => { if (!context.isCurrent()) throw fail('STALE_RESULT'); };
    let nativeStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    this.emit(active, 'planning', request.requestId);
    try {
      assertCurrent(); // Event observers are allowed to synchronously reset.
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(pending.controller.signal.reason ?? fail('CANCELLED'));
        pending.controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      timer = setTimeout(() => pending.controller.abort(fail('PLANNER_TIMEOUT')), this.options.plannerTimeoutMs ?? 45_000);
      const output = PlannerResultSchema.parse(await Promise.race([
        Promise.resolve().then(async () => {
          assertCurrent();
          if (prepareRequest) {
            const prepared = await prepareRequest(structuredClone(request), context.signal);
            assertCurrent();
            request = validatePreparedRequest(request, prepared);
            assertCurrent();
            pending.request = request;
            active.provenance = { ...active.provenance, evidenceRefs: [...request.evidenceRefs] };
          }
          return planner.plan(structuredClone(request), {
          signal: context.signal, onProgress: () => { if (context.isCurrent()) this.emit(active, 'progress', request.requestId); },
          });
        }), aborted,
      ]));
      clearTimeout(timer); timer = undefined;
      assertCurrent();
      if (output.provenance.provider !== planner.provider || output.provenance.mode !== planner.mode) throw fail('WRONG_PROVENANCE');
      const patch = validatePatch(output.patch, request);
      active.provenance = output.provenance;
      this.phase = request.kind === 'chat' ? 'chat' : 'applying';
      this.emit(active, 'applying', request.requestId, [], undefined, patch.operations);
      await this.enqueue(async () => {
        assertCurrent(); nativeStarted = true;
        await active.adapter.apply(structuredClone(patch), structuredClone(request), context);
        assertCurrent();
        const observed = NativeReadbackSchema.parse(await active.adapter.readback(context));
        assertCurrent();
        if (observed.requestId !== request.requestId || !observed.targetVisible || !observed.interactive || !observed.evidenceRefs.length) throw fail('TARGET_NOT_READY');
        const actual = validatePatch({ ...patch, operations: observed.operations }, request);
        const values = new Map(actual.operations.map(op => [op.capabilityId, op.value]));
        if (patch.operations.some(op => values.get(op.capabilityId) !== op.value)) throw fail('READBACK_MISMATCH');
        const previous = new Map(active.operations.map(op => [op.capabilityId, op.value]));
        const changed = patch.operations.some(op => previous.get(op.capabilityId) !== op.value);
        active.operations = structuredClone(patch.operations); active.explicit = structuredClone(request.explicit);
        active.committedPatch = { runId: active.runId, requestId: request.requestId,
          generation: pending.generation, limitations: [...patch.limitations] };
        this.pending = null;
        this.remaining = request.kind === 'chat' ? (changed ? Math.max(this.remaining, 30_000) : this.remaining) : 60_000;
        this.phase = 'ready'; this.explorationDeadline = this.clock.now() + this.remaining;
        this.emit(active, request.kind === 'chat' ? 'chat-applied' : 'target-ready', request.requestId, observed.evidenceRefs);
      });
    } catch (cause) {
      if (this.active === active && this.generation === pending.generation) {
        this.lastError = codeOf(cause);
        this.pending = null;
        if (nativeStarted) {
          this.phase = 'error'; this.explorationDeadline = null;
          this.emit(active, 'failed', request.requestId, [], this.lastError);
          // A partial write requires restoration. reset() waits for this lane to settle.
          await this.reset('NATIVE_FAILURE');
        } else {
          this.phase = request.kind === 'chat' ? 'ready' : 'selected';
          if (request.kind === 'chat') this.explorationDeadline = this.clock.now() + this.remaining;
          this.emit(active, 'failed', request.requestId, [], this.lastError);
        }
      }
      throw cause;
    } finally {
      if (timer) clearTimeout(timer);
      if (abortListener) pending.controller.signal.removeEventListener('abort', abortListener);
      if (this.pending === pending) { this.pending = null; this.changed(); }
    }
  }
  /** Called by a main-process interval; deadlines use monotonic time, not interval counts. */
  tick(): void {
    if (this.phase === 'ready' && this.explorationDeadline !== null && this.clock.now() >= this.explorationDeadline && this.active) {
      // Never skip the visible closing interval if the process resumes after a stall/sleep.
      this.remaining = 0; this.explorationDeadline = null; this.closingDeadline = this.clock.now() + 20_000; this.phase = 'closing';
      this.emit(this.active, 'closing');
    } else if (this.phase === 'closing' && this.closingDeadline !== null && this.clock.now() >= this.closingDeadline) {
      void this.reset('EXPIRED').catch(() => undefined);
    } else this.changed();
  }
  reset(reason = 'OPERATOR_RESET'): Promise<void> {
    if (this.resetPromise) return this.resetPromise;
    const active = this.active ?? this.recovery;
    if (!active) return Promise.resolve();
    this.generation++;
    this.pending?.controller.abort(fail(reason)); this.pending = null;
    this.active = null; this.recovery = active;
    // Retain only adapter and technical identity for recovery/events, no visitor profile/chat.
    active.explicit = []; active.operations = []; active.committedPatch = null;
    active.selection = { scenarioId: active.selection.scenarioId, target: active.selection.target,
      source: { version: 1, profileId: 'cleared', revision: '1', sourceApp: active.selection.source.sourceApp,
        personaId: 'cleared', label: 'Cleared', provenance: { mode: 'prepared', provider: 'none', evidenceRefs: ['cleared'] },
        evidenceRefs: ['cleared'], bindings: {}, preferences: [] } };
    this.remaining = 0; this.explorationDeadline = null; this.closingDeadline = null; this.phase = 'resetting';
    const generation = this.generation;
    // Assign the Promise before emitting: observer reentrancy sees an already-running reset.
    this.resetPromise = this.enqueue(async () => {
      const result = NativeResetResultSchema.parse(await active.adapter.reset({ runId: active.runId, generation }));
      if (!result.targetClosed || !result.preferencesRestored || !result.visitorArtifactsCleared || !result.evidenceRefs.length) throw fail('NATIVE_RESET_UNVERIFIED');
      const desktop = DesktopResultSchema.parse(await this.options.desktop.returnToDesktop());
      if (!desktop.desktopVisible || !desktop.evidenceRefs.length) throw fail('DESKTOP_UNVERIFIED');
      this.phase = 'idle'; this.lastError = null; this.remaining = 60_000;
      this.emit(active, 'reset-completed', null, [...result.evidenceRefs, ...desktop.evidenceRefs]);
      this.recovery = null;
    }).catch(cause => {
      this.phase = 'error'; this.lastError = codeOf(cause);
      this.emit(active, 'failed', null, [], this.lastError); throw cause;
    }).finally(() => { this.resetPromise = null; this.changed(); });
    this.emit(active, 'reset-started');
    return this.resetPromise;
  }
}
