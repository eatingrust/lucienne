import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validatePatch, type NativePatch, type PlannerRequest } from '../../contracts/index.js';
import { NativeReadbackSchema, NativeResetResultSchema, type CommitContext, type NativeAdapter, type NativeReadback, type NativeResetResult } from '../../contracts/ports.js';
import { REAPER_TARGET, REAPER_BINDING_EVIDENCE, REAPER_NATIVE_SEMANTICS, catalogForSource, assertReaperRequest } from './catalog.js';
import { ReaperRuntime, type ReaperResetInspection, type ReaperRuntimeOptions, type ReaperRuntimePort } from './runtime.js';
import { assertCurrent } from './transport.js';
import { assertReaperPath } from './baseline.js';
import { projectReaperTaskObservation, type ReaperObservation } from './observation.js';
export { REAPER_TARGET, catalogForSource, createReaperBindingSetup, resolveReaperRecipe, REAPER_NATIVE_SEMANTICS, REAPER_BINDING_EVIDENCE } from './catalog.js';
export { projectReaperTaskObservation, type ReaperObservation } from './observation.js';
export { createReaperExample, createPreparedReaperResult, REAPER_CHAT_PROMPTS } from './example.js';
export { DEFAULT_REAPER_APP, type ReaperResetInspection } from './runtime.js';

export interface ReaperAdapterOptions extends ReaperRuntimeOptions { buildId: string; evidenceDirectory: string }
type Identity = Pick<CommitContext, 'runId' | 'requestId' | 'generation'>;
type BindingEvidenceScope = Pick<PlannerRequest, 'scenarioId' | 'source' | 'target' | 'catalog' | 'bindingApplicability'>;
export interface EvidenceArtifact { id: string; path: string; sha256: string; buildId: string; runId: string; evidenceKind: 'native' }

export class ReaperAdapter implements NativeAdapter {
  readonly target = REAPER_TARGET;
  readonly evidenceKind = 'native' as const;
  readonly catalog;
  private readonly runtime: ReaperRuntimePort;
  private lane: Promise<unknown> = Promise.resolve();
  private ownerRun?: string;
  private generationFloor = -1;
  private last?: Identity;
  private lastReset?: Identity;
  private recoveryRequired = false;
  private resetting = false;
  private resetPromise?: Promise<NativeResetResult>;
  private active?: AbortController;
  private queued = 0;
  private artifacts: EvidenceArtifact[] = [];
  private readonly bindingScopes = new Map<string, BindingEvidenceScope>();
  constructor(private readonly options: ReaperAdapterOptions) {
    this.catalog = catalogForSource(options.source);
    const runtime = new ReaperRuntime(options); this.runtime = runtime;
    if (!path.isAbsolute(options.evidenceDirectory) || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(options.buildId))
      throw new Error('REAPER_BAD_EVIDENCE_OPTIONS');
    const sessionRoot = runtime.sessionRoot;
    if (path.resolve(options.evidenceDirectory) === sessionRoot || path.resolve(options.evidenceDirectory).startsWith(sessionRoot + path.sep))
      throw new Error('REAPER_EVIDENCE_INSIDE_SESSION');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.queued++;
    const next = this.lane.then(operation, operation).finally(() => { this.queued--; });
    this.lane = next.catch(() => undefined); return next;
  }
  isQuiescent(): boolean { return this.queued === 0 && !this.active && !this.resetting; }
  getEvidenceArtifacts(runId?: string): EvidenceArtifact[] {
    return structuredClone(runId === undefined ? this.artifacts : this.artifacts.filter(artifact => artifact.runId === runId));
  }
  private identityMatches(input: Identity): boolean {
    return !!this.last && this.last.runId === input.runId && this.last.requestId === input.requestId && this.last.generation === input.generation;
  }
  private async record(kind: string, identity: Identity, observed: unknown): Promise<string[]> {
    const id = `reaper:${kind}:${randomUUID()}`;
    await assertReaperPath(this.options.evidenceDirectory);
    await mkdir(this.options.evidenceDirectory, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ version: 1, id, buildId: this.options.buildId, ...identity,
      evidenceKind: 'native', observedAt: new Date().toISOString(), observed }, null, 2);
    const file = `${id.replaceAll(':', '-')}.json`;
    await writeFile(path.join(this.options.evidenceDirectory, file), body, { flag: 'wx', mode: 0o600 });
    const artifact: EvidenceArtifact = {
      id, path: file, sha256: createHash('sha256').update(body).digest('hex'), buildId: this.options.buildId,
      runId: identity.runId, evidenceKind: 'native',
    };
    await writeFile(path.join(this.options.evidenceDirectory, file + '.manifest.json'), JSON.stringify(artifact), { flag: 'wx', mode: 0o600 });
    this.artifacts.push(artifact);
    return [id];
  }
  private bindingScope(request: PlannerRequest): BindingEvidenceScope {
    // Full source provenance and every policy entry/ref stay immutable. Request
    // evidence can additionally carry initial-only preparation context; it is
    // not part of binding identity. assertReaperRequest independently requires
    // every policy evidence ref to be trusted by EACH request before this check.
    return { scenarioId: request.scenarioId, source: request.source, target: request.target,
      catalog: request.catalog, bindingApplicability: request.bindingApplicability };
  }
  private assertBindingScope(request: PlannerRequest): void {
    const previous = this.bindingScopes.get(request.runId);
    if (previous && !isDeepStrictEqual(previous, this.bindingScope(request))) throw new Error('REAPER_BINDING_SCOPE_CHANGED');
  }
  private async bindingEvidence(request: PlannerRequest, context: CommitContext): Promise<void> {
    this.assertBindingScope(request);
    // Keep the admitted scope through reset: a reused run ID cannot silently
    // acquire different declaration bytes under the same fixed evidence ref.
    if (!this.bindingScopes.has(context.runId)) this.bindingScopes.set(context.runId, structuredClone(this.bindingScope(request)));
    if (this.artifacts.some(artifact => artifact.id === REAPER_BINDING_EVIDENCE && artifact.runId === context.runId)) return;
    const policy = request.bindingApplicability!; // assertReaperRequest requires it.
    const id = REAPER_BINDING_EVIDENCE;
    const body = JSON.stringify({ version: 1, id, buildId: this.options.buildId, runId: context.runId,
      evidenceKind: 'native', kind: 'binding-recipe-declaration', provenance: 'adapter-validated-host-policy',
      target: request.target, scenarioId: request.scenarioId, source: request.source,
      bindingApplicability: policy, catalog: request.catalog, initialRequestEvidenceRefs: request.evidenceRefs,
      canonicalMappedSemantics: request.catalog.filter(capability => capability.bindingAction).map(capability => ({
        capabilityId: capability.id, bindingAction: capability.bindingAction,
        limitation: REAPER_NATIVE_SEMANTICS[capability.bindingAction as keyof typeof REAPER_NATIVE_SEMANTICS],
      })),
      externalEvidenceRefs: [...new Set(policy.entries.flatMap(entry => entry.evidenceRefs))].filter(ref => ref !== id),
      limitation: 'This declaration attests only the canonical mapped REAPER semantics admitted for this run. Host-supplied source aliases and nonmapped dispositions retain their own provenance; external evidence references require independent verified artifacts. This declaration does not prove installed shortcuts, native actions, readiness, tasks or reset.',
    }, null, 2) + '\n';
    assertCurrent(context);
    await assertReaperPath(this.options.evidenceDirectory);
    await mkdir(this.options.evidenceDirectory, { recursive: true, mode: 0o700 });
    assertCurrent(context);
    const file = `reaper-binding-policy-${randomUUID()}.json`;
    await writeFile(path.join(this.options.evidenceDirectory, file), body, { flag: 'wx', mode: 0o600 });
    const artifact: EvidenceArtifact = { id, path: file, sha256: createHash('sha256').update(body).digest('hex'),
      buildId: this.options.buildId, runId: context.runId, evidenceKind: 'native' };
    await writeFile(path.join(this.options.evidenceDirectory, file + '.manifest.json'), JSON.stringify(artifact), { flag: 'wx', mode: 0o600 });
    this.artifacts.push(artifact);
    assertCurrent(context);
  }
  private contextual<T>(source: CommitContext, action: (context: CommitContext) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const controller = new AbortController(); this.active = controller;
      const context: CommitContext = { ...source, signal: AbortSignal.any([source.signal, controller.signal]),
        isCurrent: () => !this.resetting && source.isCurrent() };
      const revoke = () => this.runtime.revokeActions();
      context.signal.addEventListener('abort', revoke, { once: true });
      try { assertCurrent(context); return await action(context); }
      finally { context.signal.removeEventListener('abort', revoke); this.active = undefined; }
    });
  }
  async apply(rawPatch: NativePatch, rawRequest: PlannerRequest, source: CommitContext): Promise<void> {
    const request = assertReaperRequest(rawRequest), patch = validatePatch(rawPatch, request);
    if (request.source.sourceApp !== this.options.source) throw new Error('REAPER_SOURCE_ADAPTER_MISMATCH');
    if (source.runId !== patch.runId || source.requestId !== patch.requestId) throw new Error('REAPER_CONTEXT_IDENTITY');
    if (this.resetting || this.recoveryRequired) throw new Error('REAPER_RESET_REQUIRED');
    await this.contextual(source, async context => {
      if (this.recoveryRequired || context.generation < this.generationFloor || (this.ownerRun && this.ownerRun !== context.runId))
        throw new Error('REAPER_STALE_CONTEXT');
      this.assertBindingScope(request);
      this.ownerRun = context.runId; this.generationFloor = Math.max(this.generationFloor, context.generation);
      this.lastReset = undefined;
      this.recoveryRequired = true;
      try {
        await this.bindingEvidence(request, context); assertCurrent(context);
        await this.runtime.start(context); assertCurrent(context);
        await this.runtime.command('apply', context, patch.operations); assertCurrent(context);
      } catch (error) { this.runtime.revokeActions(); throw error; }
      this.last = { runId: context.runId, requestId: context.requestId, generation: context.generation };
      this.recoveryRequired = false;
    });
  }
  async readback(source: CommitContext): Promise<NativeReadback> {
    if (this.resetting || this.recoveryRequired) throw new Error('REAPER_RESET_REQUIRED');
    return this.contextual(source, async context => {
      if (this.recoveryRequired) throw new Error('REAPER_RESET_REQUIRED');
      if (!this.identityMatches(context)) throw new Error('REAPER_READBACK_IDENTITY');
      try {
        const result = NativeReadbackSchema.parse(await this.runtime.readback(context)); assertCurrent(context);
        if (result.requestId !== context.requestId) throw new Error('REAPER_READBACK_IDENTITY');
        result.evidenceRefs = await this.record('readback', context, result); assertCurrent(context); return result;
      } catch (error) { this.recoveryRequired = true; this.runtime.revokeActions(); throw error; }
    });
  }
  async observe(input: Identity & Partial<Pick<CommitContext, 'signal' | 'isCurrent'>>): Promise<ReaperObservation & { evidenceRefs: string[] }> {
    if (this.resetting || this.recoveryRequired) throw new Error('REAPER_RESET_REQUIRED');
    const source: CommitContext = { ...input, signal: input.signal ?? new AbortController().signal,
      isCurrent: input.isCurrent ?? (() => this.identityMatches(input)) };
    return this.contextual(source, async context => {
      if (this.recoveryRequired) throw new Error('REAPER_RESET_REQUIRED');
      if (!this.identityMatches(context)) throw new Error('REAPER_OBSERVATION_IDENTITY');
      try {
        const result = await this.runtime.command<ReaperObservation>('observe', context); assertCurrent(context);
        const evidenceRefs = await this.record('task', context, result); assertCurrent(context);
        return { ...result, evidenceRefs };
      } catch (error) { this.recoveryRequired = true; this.runtime.revokeActions(); throw error; }
    });
  }
  /** Exact native QA NativeTaskSnapshot<PlaybackTaskState>; raw native evidence is
   * captured by observe before projection, including any rejected readback. */
  async observeTask(input: Identity & Partial<Pick<CommitContext, 'signal' | 'isCurrent'>>) {
    return projectReaperTaskObservation(await this.observe(input));
  }
  async inspectReset(): Promise<ReaperResetInspection & { evidenceRefs: string[] }> {
    if (!this.isQuiescent() || this.recoveryRequired || !this.runtime.inspectReset) throw new Error('REAPER_RESET_INSPECTION_UNAVAILABLE');
    return this.enqueue(async () => {
      const identity = this.lastReset;
      const current = () => !!identity && this.lastReset === identity && !this.ownerRun && !this.recoveryRequired && !this.resetting;
      if (!current()) throw new Error('REAPER_RESET_INSPECTION_UNAVAILABLE');
      // Keep a new apply behind both fresh file/process inspection and its
      // evidence write. This proves only the explicitly owned settings scope.
      const observed = await this.runtime.inspectReset!();
      if (!current()) throw new Error('REAPER_RESET_INSPECTION_STALE');
      const evidenceRefs = await this.record('reset-inspection', identity!, observed);
      if (!current()) throw new Error('REAPER_RESET_INSPECTION_STALE');
      return { ...observed, evidenceRefs };
    });
  }
  reset(identity: { runId: string; generation: number }): Promise<NativeResetResult> {
    if (this.ownerRun && this.ownerRun !== identity.runId) throw new Error('REAPER_RESET_IDENTITY');
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 0 || identity.generation < this.generationFloor) throw new Error('REAPER_BAD_GENERATION');
    if (this.resetPromise) return this.resetPromise;
    this.resetting = true; this.generationFloor = identity.generation; this.runtime.revokeActions(); this.active?.abort();
    const context: CommitContext = { ...identity, requestId: `${identity.runId}:reaper-reset`,
      signal: new AbortController().signal, isCurrent: () => this.resetting };
    this.resetPromise = this.enqueue(async () => {
      const result = NativeResetResultSchema.parse(await this.runtime.reset(context));
      if (!result.targetClosed || !result.preferencesRestored || !result.visitorArtifactsCleared)
        throw new Error('REAPER_INCOMPLETE_RESET');
      result.evidenceRefs = await this.record('reset', context, result);
      this.last = undefined; this.ownerRun = undefined; this.recoveryRequired = false;
      this.lastReset = { runId: context.runId, requestId: context.requestId, generation: context.generation };
      return result;
    }).catch(error => { this.recoveryRequired = true; throw error; })
      .finally(() => { this.resetting = false; this.resetPromise = undefined; });
    return this.resetPromise;
  }
}
export function createReaperAdapter(options: ReaperAdapterOptions): ReaperAdapter { return new ReaperAdapter(options); }
