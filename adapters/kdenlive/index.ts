import { NativeReadbackSchema, NativeResetResultSchema, type CommitContext, type NativeAdapter, type NativeReadback, type NativeResetResult } from '../../contracts/ports.js';
import { validatePatch, type NativePatch, type PlannerRequest, type SourceApp } from '../../contracts/index.js';
import { assertKdenliveRequest, KDENLIVE_TARGET, kdenliveCatalog } from './catalog.js';
export * from './catalog.js';
export function assertCurrent(context: CommitContext): void {
  if (!Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('KDENLIVE_BAD_GENERATION');
  if (context.signal.aborted || !context.isCurrent()) throw new Error('KDENLIVE_STALE_CONTEXT');
}
export interface KdenliveDriver {
  readonly evidenceKind: 'native' | 'fixture';
  /** Must guard immediately before each mutation, drain children on cancellation,
   * and capture a baseline before the first possible native write. */
  apply(patch: NativePatch, request: PlannerRequest, context: CommitContext): Promise<void>;
  /** Independently inspect target process/UI, not the submitted patch. */
  readback(context: CommitContext): Promise<NativeReadback>;
  reset(identity: {runId: string; generation: number}): Promise<NativeResetResult>;
}
/** Session/timer authority stays in host. This lane only owns native quiescence. */
export class KdenliveAdapter implements NativeAdapter {
  readonly target = KDENLIVE_TARGET;
  readonly catalog;
  readonly evidenceKind;
  private lane: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private resetPending = false;
  private resetPromise?: Promise<NativeResetResult>;
  private active?: AbortController;
  private ownerRun?: string;
  private last?: {runId: string; requestId: string; generation: number};
  private generationFloor = -1;
  private dirty = false;
  constructor(readonly sourceApp: SourceApp, private readonly driver: KdenliveDriver) {
    this.catalog = kdenliveCatalog(sourceApp); this.evidenceKind = driver.evidenceKind;
  }
  isQuiescent() { return this.pending === 0; }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.lane.then(fn).finally(() => { this.pending--; });
    this.lane = result.catch(() => undefined); return result;
  }
  private context(input: CommitContext): CommitContext {
    const controller = new AbortController(); this.active = controller;
    return { ...input, signal: AbortSignal.any([controller.signal, input.signal]), isCurrent: () => !this.resetPending && input.isCurrent() };
  }
  apply(raw: NativePatch, rawRequest: PlannerRequest, rawContext: CommitContext): Promise<void> {
    const input = { ...rawContext };
    if (this.resetPending) throw new Error('KDENLIVE_RESET_PENDING');
    const request = assertKdenliveRequest(structuredClone(rawRequest), this.sourceApp);
    const patch = validatePatch(structuredClone(raw), request);
    if (input.runId !== request.runId || input.requestId !== request.requestId) throw new Error('KDENLIVE_CONTEXT_MISMATCH');
    assertCurrent(input);
    return this.enqueue(async () => {
      const context = this.context(input);
      try {
        assertCurrent(context);
        if (this.dirty || context.generation <= this.generationFloor || (this.ownerRun && this.ownerRun !== context.runId) ||
          (this.last && context.generation < this.last.generation)) throw new Error('KDENLIVE_RESET_REQUIRED');
        this.ownerRun = context.runId; this.dirty = true;
        await this.driver.apply(patch, request, context);
        assertCurrent(context);
        this.last = {runId: context.runId, requestId: context.requestId, generation: context.generation}; this.dirty = false;
      } finally { this.active = undefined; }
    });
  }
  readback(rawContext: CommitContext): Promise<NativeReadback> {
    const input = { ...rawContext };
    if (this.resetPending) throw new Error('KDENLIVE_RESET_PENDING');
    return this.enqueue(async () => {
      const context = this.context(input);
      try {
        assertCurrent(context);
        if (this.dirty || !this.last || this.last.runId !== context.runId || this.last.requestId !== context.requestId || this.last.generation !== context.generation)
          throw new Error('KDENLIVE_READBACK_IDENTITY');
        const result = NativeReadbackSchema.parse(await this.driver.readback(context));
        assertCurrent(context);
        if (result.requestId !== context.requestId) throw new Error('KDENLIVE_READBACK_IDENTITY');
        if (new Set(result.operations.map(op => op.capabilityId)).size !== result.operations.length || result.operations.some(op => {
          const c = this.catalog.find(c => c.id === op.capabilityId); return !c || !c.values.includes(op.value);
        })) throw new Error('KDENLIVE_INVALID_OBSERVATION');
        return result;
      } finally { this.active = undefined; }
    });
  }
  reset(rawIdentity: {runId: string; generation: number}): Promise<NativeResetResult> {
    const identity = { ...rawIdentity };
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new Error('KDENLIVE_BAD_GENERATION');
    if (this.ownerRun && identity.runId !== this.ownerRun) throw new Error('KDENLIVE_RESET_IDENTITY');
    if (this.last && identity.generation < this.last.generation) throw new Error('KDENLIVE_STALE_RESET');
    if (this.resetPromise) return this.resetPromise;
    this.generationFloor = Math.max(this.generationFloor, identity.generation);
    this.resetPending = true; this.active?.abort();
    this.resetPromise = this.enqueue(async () => {
      const result = NativeResetResultSchema.parse(await this.driver.reset(identity));
      if (!result.targetClosed || !result.preferencesRestored || !result.visitorArtifactsCleared) throw new Error('KDENLIVE_RESET_INCOMPLETE');
      this.ownerRun = undefined; this.last = undefined; this.dirty = false;
      return result;
    }).catch(error => { this.dirty = true; throw error; }).finally(() => {this.resetPending = false; this.resetPromise = undefined;});
    return this.resetPromise;
  }
}
