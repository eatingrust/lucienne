import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { NativeReadbackSchema, type CommitContext, type NativeAdapter, type NativeReadback, type NativeResetResult } from '../../contracts/ports.js';
import { SourceProfileSchema, type Capability, type NativePatch, type PlannerRequest } from '../../contracts/index.js';
import { assertBlenderRequest, validateBlenderPatch, createBlenderBindingSetup, expandBlenderOperations, projectBlenderReadback, BLENDER_TARGET, BLENDER_CATALOG, BLENDER_BINDING_EVIDENCE, type BlenderBindingContext } from './catalog.js';
import { assertCurrent } from './transport.js';
import { BlenderRuntime, assertNoSymlinkPath, type BlenderRuntimeOptions } from './runtime.js';
export { BLENDER_TARGET, BLENDER_CATALOG, resolveBlenderRecipe, createBlenderBindingSetup } from './catalog.js';
export { DEFAULT_BLENDER_APP } from './runtime.js';

export interface ObservationContext { readonly runId: string; readonly requestId: string; readonly generation: number }
export interface EvidenceArtifact {
  id: string; path: string; sha256: string; buildId: string; runId: string; evidenceKind: 'native';
}
const nativeObjectId = z.string().regex(/^blender:object:[a-f0-9]{64}$/);
const BlenderObservationSchema = z.object({
  contextId: z.string().regex(/^blender:scene:[a-f0-9]{64}$/),
  taskState: z.object({
    objects: z.array(z.object({ id: nativeObjectId, name: z.string().min(1), selected: z.boolean(),
      location: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
    }).passthrough()),
    activeObject: z.string().min(1).nullable(), activeObjectId: nativeObjectId.nullable(), mode: z.string().min(1),
  }).passthrough(),
  geometry: z.unknown(), evidenceRefs: z.array(z.string().min(1)),
}).passthrough();
export type BlenderObservation = z.infer<typeof BlenderObservationSchema>;
function validateObservation(value: unknown): BlenderObservation {
  const observed = BlenderObservationSchema.parse(value);
  const objects = observed.taskState.objects;
  if (new Set(objects.map(object => object.id)).size !== objects.length ||
      (observed.taskState.activeObjectId === null ? observed.taskState.activeObject !== null :
        !objects.some(object => object.id === observed.taskState.activeObjectId && object.name === observed.taskState.activeObject)))
    throw new Error('BLENDER_OBSERVATION_IDENTITY_INVALID');
  return observed;
}
/** Shared QA projection of complete observed native entities, never requested values. */
export function projectBlenderTaskObservation(value: unknown) {
  const observed = validateObservation(value);
  if (!observed.evidenceRefs.length) throw new Error('BLENDER_OBSERVATION_EVIDENCE_REQUIRED');
  return { contextId: observed.contextId,
    taskState: { selectedIds: observed.taskState.objects.filter(object => object.selected).map(object => object.id),
      positions: Object.fromEntries(observed.taskState.objects.map(object => [object.id, [...object.location] as [number, number, number]])) },
    evidenceRefs: [...observed.evidenceRefs] };
}
export interface BlenderAdapterOptions extends BlenderRuntimeOptions {
  buildId: string; evidenceDirectory: string;
  /** Host-selected immutable source scope. Recreate this adapter after reset or a source change. */
  bindingContext?: BlenderBindingContext;
}
function scopeDigest(context: BlenderBindingContext): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  return createHash('sha256').update(JSON.stringify(canonical({ scenarioId: context.scenarioId, source: SourceProfileSchema.parse(context.source) }))).digest('hex');
}

export class BlenderAdapter implements NativeAdapter {
  readonly target = BLENDER_TARGET;
  readonly evidenceKind = 'native' as const;
  readonly catalog: readonly Capability[];
  private readonly options: Omit<BlenderAdapterOptions, 'bindingContext'>;
  private readonly scoped: boolean;
  private bindingScopeDigest?: string;
  private readonly runtime: BlenderRuntime;
  private lane: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private last?: ObservationContext;
  private activeObserver?: AbortController;
  private activeNative?: AbortController;
  private resetPending = false;
  private ownerRun?: string;
  private recoveryRequired = false;
  private generationFloor = -1;
  private highestAdmittedGeneration = -1;
  private lastResetIdentity?: ObservationContext;
  private resetReceipt?: Awaited<ReturnType<BlenderRuntime['reset']>>;
  private resetPromise?: Promise<NativeResetResult>;
  private artifacts: EvidenceArtifact[] = [];
  constructor(options: BlenderAdapterOptions) {
    const { bindingContext, ...runtimeOptions } = options;
    this.scoped = !!bindingContext;
    this.catalog = bindingContext ? createBlenderBindingSetup(bindingContext).catalog : BLENDER_CATALOG;
    this.bindingScopeDigest = bindingContext ? scopeDigest(bindingContext) : undefined;
    if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(options.buildId)) throw new Error('BLENDER_INVALID_BUILD_ID');
    assertNoSymlinkPath(options.evidenceDirectory);
    this.options = { ...runtimeOptions, evidenceDirectory: path.resolve(options.evidenceDirectory) };
    this.runtime = new BlenderRuntime(runtimeOptions);
    if (this.options.evidenceDirectory === this.runtime.sessionRoot || this.options.evidenceDirectory.startsWith(`${this.runtime.sessionRoot}/`))
      throw new Error('BLENDER_EVIDENCE_INSIDE_SESSION');
  }
  preflight() { return this.runtime.preflight(); }
  getBaselineSnapshot() { return this.runtime.getBaselineSnapshot(); }
  inspectReset() {
    return this.enqueue(async () => {
      if (this.resetPending || this.ownerRun || !this.lastResetIdentity) throw new Error('BLENDER_RESET_NOT_COMPLETED');
      const observation = await this.runtime.inspectReset();
      const evidenceRefs = await this.evidence('independent-reset-inspection', this.lastResetIdentity, observation);
      return { ...observation, evidenceRefs };
    });
  }
  getEvidenceArtifacts(): EvidenceArtifact[] { return structuredClone(this.artifacts); }
  isQuiescent(): boolean { return this.queued === 0 && this.runtime.isQuiescent(); }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.queued++;
    const result = this.lane.then(work).finally(() => { this.queued--; });
    this.lane = result.catch(() => undefined);
    return result;
  }
  private matches(context: ObservationContext): boolean {
    return !this.resetPending && !this.recoveryRequired && !!this.last && this.last.runId === context.runId &&
      this.last.requestId === context.requestId && this.last.generation === context.generation;
  }
  private async evidence(kind: string, context: ObservationContext, observation: unknown): Promise<string[]> {
    const id = `blender:${randomUUID()}`, file = path.join(this.options.evidenceDirectory, `${id.slice('blender:'.length)}.json`);
    const bytes = JSON.stringify({ version: 1, id, buildId: this.options.buildId,
      runId: context.runId, requestId: context.requestId, generation: context.generation,
      evidenceKind: 'native', kind, observedAt: new Date().toISOString(), observation }, null, 2) + '\n';
    assertNoSymlinkPath(this.options.evidenceDirectory);
    await mkdir(this.options.evidenceDirectory, { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    this.artifacts.push({ id, path: file, sha256: createHash('sha256').update(bytes).digest('hex'),
      buildId: this.options.buildId, runId: context.runId, evidenceKind: 'native' });
    return [id];
  }
  private async bindingEvidence(request: PlannerRequest, context: CommitContext): Promise<void> {
    if (!request.bindingApplicability || this.artifacts.some(artifact =>
      artifact.id === BLENDER_BINDING_EVIDENCE && artifact.runId === context.runId)) return;
    const trusted = createBlenderBindingSetup(request);
    const id = BLENDER_BINDING_EVIDENCE;
    const bytes = JSON.stringify({ version: 1, id, buildId: this.options.buildId, runId: context.runId,
      evidenceKind: 'native', kind: 'binding-recipe-declaration', provenance: 'adapter-authored-policy',
      target: BLENDER_TARGET, bindingApplicability: trusted.bindingApplicability, catalog: trusted.catalog,
      limitation: 'Authored adapter policy for this native run; this declaration does not prove native actions, readiness, tasks or reset.',
    }, null, 2) + '\n';
    assertCurrent(context); assertNoSymlinkPath(this.options.evidenceDirectory);
    await mkdir(this.options.evidenceDirectory, { recursive: true, mode: 0o700 });
    assertCurrent(context);
    const file = path.join(this.options.evidenceDirectory, `${randomUUID()}.json`);
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    this.artifacts.push({ id, path: file, sha256: createHash('sha256').update(bytes).digest('hex'),
      buildId: this.options.buildId, runId: context.runId, evidenceKind: 'native' });
  }
  apply(value: NativePatch, input: PlannerRequest, sourceContext: CommitContext): Promise<void> {
    if (this.resetPending) throw new Error('BLENDER_RESET_PENDING');
    if (this.recoveryRequired || sourceContext.generation <= this.generationFloor) throw new Error('BLENDER_RESET_REQUIRED');
    // Snapshot before the queued wait; callers cannot mutate an already validated patch.
    const request = assertBlenderRequest(structuredClone(input));
    if (this.scoped) {
      if (!this.bindingScopeDigest) throw new Error('BLENDER_SCOPED_ADAPTER_RETIRED');
      if (!request.bindingApplicability || scopeDigest(request) !== this.bindingScopeDigest) throw new Error('BLENDER_BINDING_SCOPE_MISMATCH');
    } else if (request.bindingApplicability) throw new Error('BLENDER_BINDING_SCOPE_REQUIRED');
    const patch = validateBlenderPatch(structuredClone(value), request);
    if (sourceContext.runId !== request.runId || sourceContext.requestId !== request.requestId) throw new Error('BLENDER_CONTEXT_MISMATCH');
    assertCurrent(sourceContext);
    if (sourceContext.generation < this.highestAdmittedGeneration) throw new Error('BLENDER_STALE_GENERATION');
    this.highestAdmittedGeneration = sourceContext.generation;
    return this.enqueue(async () => {
      const controller = new AbortController(); this.activeNative = controller;
      const context: CommitContext = { ...sourceContext, signal: AbortSignal.any([sourceContext.signal, controller.signal]),
        isCurrent: () => !this.resetPending && sourceContext.isCurrent() };
      try {
      assertCurrent(context);
      if (this.resetPending) throw new Error('BLENDER_RESET_PENDING');
      if (this.recoveryRequired || context.generation <= this.generationFloor ||
          (this.ownerRun && this.ownerRun !== context.runId) ||
          (this.last && this.last.generation > context.generation)) throw new Error('BLENDER_RESET_REQUIRED');
      this.ownerRun = context.runId;
      await this.bindingEvidence(request, context);
      assertCurrent(context);
      const hello = await this.runtime.start(context);
      assertCurrent(context);
      await this.runtime.command('apply', context, expandBlenderOperations(patch, request));
      assertCurrent(context);
      await this.runtime.focus(context);
      assertCurrent(context);
      this.last = { runId: context.runId, requestId: context.requestId, generation: context.generation };
      await this.evidence('native-apply-acknowledgement', this.last, { hello, baseline: this.runtime.getBaselineSnapshot() });
      assertCurrent(context);
      } catch (error) { this.recoveryRequired = true; throw error; }
      finally { this.activeNative = undefined; }
    });
  }
  readback(sourceContext: CommitContext): Promise<NativeReadback> {
    if (this.resetPending) throw new Error('BLENDER_RESET_PENDING');
    if (this.recoveryRequired) throw new Error('BLENDER_RESET_REQUIRED');
    return this.enqueue(async () => {
      const controller = new AbortController(); this.activeNative = controller;
      const context: CommitContext = { ...sourceContext, signal: AbortSignal.any([sourceContext.signal, controller.signal]),
        isCurrent: () => !this.resetPending && sourceContext.isCurrent() };
      try {
      assertCurrent(context);
      if (this.recoveryRequired || !this.matches(context)) throw new Error('BLENDER_READBACK_IDENTITY');
      const observed = NativeReadbackSchema.parse(await this.runtime.command('readback', context));
      assertCurrent(context);
      if (observed.requestId !== context.requestId) throw new Error('BLENDER_READBACK_IDENTITY');
      // Actual values remain actual even on mismatch; coordinator compares against desired state.
      observed.evidenceRefs = await this.evidence('native-readback', context, observed);
      observed.operations = projectBlenderReadback(observed.operations, this.catalog);
      assertCurrent(context);
      return observed;
      } finally { this.activeNative = undefined; }
    });
  }
  observe(input: ObservationContext): Promise<BlenderObservation> {
    const identity = { runId: input.runId, requestId: input.requestId, generation: input.generation };
    return this.enqueue(async () => {
      if (this.recoveryRequired) throw new Error('BLENDER_RESET_REQUIRED');
      if (!this.matches(identity)) throw new Error('BLENDER_OBSERVATION_STALE');
      const controller = new AbortController(); this.activeObserver = controller;
      const context: CommitContext = { ...identity, signal: controller.signal, isCurrent: () => this.matches(identity) };
      try {
        const nativeObservation = validateObservation(await this.runtime.command<BlenderObservation>('observe', context));
        // Native JSON may contain -0.0. Return the same JSON representation that
        // evidence persists, so strict saved/returned comparisons agree. Validate
        // first: serialization must never turn an invalid coordinate into null.
        const observation: BlenderObservation = JSON.parse(JSON.stringify(nativeObservation));
        assertCurrent(context);
        observation.evidenceRefs = await this.evidence('native-task-observation', identity, observation);
        assertCurrent(context); return observation;
      } finally { this.activeObserver = undefined; }
    });
  }
  reset(identity: { runId: string; generation: number }): Promise<NativeResetResult> {
    if (this.ownerRun && this.ownerRun !== identity.runId) throw new Error('BLENDER_RESET_IDENTITY');
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new Error('BLENDER_BAD_GENERATION');
    if (identity.generation < this.highestAdmittedGeneration) throw new Error('BLENDER_STALE_GENERATION');
    if (this.resetPromise) return this.resetPromise;
    this.generationFloor = Math.max(this.generationFloor, identity.generation, this.highestAdmittedGeneration);
    this.resetPending = true; this.activeNative?.abort(); this.activeObserver?.abort();
    const context: CommitContext = { ...identity, requestId: `${identity.runId}:native-reset`,
      signal: new AbortController().signal, isCurrent: () => this.resetPending };
    this.resetPromise = this.enqueue(async () => {
      const restored = this.resetReceipt ?? await this.runtime.reset(context);
      this.resetReceipt = restored;
      const evidenceRefs = await this.evidence('native-reset', context, restored);
      this.lastResetIdentity = { runId: context.runId, requestId: context.requestId, generation: context.generation };
      this.last = undefined; this.bindingScopeDigest = undefined; this.ownerRun = undefined; this.recoveryRequired = false; this.resetReceipt = undefined;
      return { targetClosed: restored.targetClosed, preferencesRestored: restored.preferencesRestored,
        visitorArtifactsCleared: restored.visitorArtifactsCleared, evidenceRefs };
    }).catch(error => { this.recoveryRequired = true; throw error; })
      .finally(() => { this.resetPending = false; this.resetPromise = undefined; });
    return this.resetPromise;
  }
}
export function createBlenderAdapter(options: BlenderAdapterOptions): BlenderAdapter { return new BlenderAdapter(options); }
export { BLENDER_CHAT_PROMPTS, blenderChatExplicit } from './chat.js';
export type { BlenderBindingContext, BlenderBindingSetup } from './catalog.js';
