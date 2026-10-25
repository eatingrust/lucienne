import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NativeReadbackSchema, type CommitContext, type NativeAdapter, type NativeReadback, type NativeResetResult } from '../../contracts/ports.js';
import { validatePatch, type NativePatch, type PlannerRequest } from '../../contracts/index.js';
import { assertKritaRequest, KRITA_TARGET, KRITA_CATALOG } from './catalog.js';
import { assertCurrent, diagnosticCode } from './transport.js';
import { KritaRuntime, assertNoSymlinkPath, type KritaRuntimeOptions } from './runtime.js';
export { KRITA_TARGET, KRITA_CATALOG, resolveKritaRecipe } from './catalog.js';
export { DEFAULT_KRITA_APP } from './runtime.js';

export interface ObservationContext { readonly runId: string; readonly requestId: string; readonly generation: number }
export interface EvidenceArtifact {
  id: string; path: string; sha256: string; buildId: string; runId: string; evidenceKind: 'native';
}
export interface DiagnosticArtifact {
  id: string; path: string; sha256: string; buildId: string; runId: string; diagnosticOnly: true;
}
export interface KritaObservation {
  taskState: { pixelDigest: string; selectionPixels: number; selectionDigest: string; layerId: string; bounds: number[] };
  otherLayers: Record<string, string>;
  geometry: unknown;
  evidenceRefs: string[];
  [key: string]: unknown;
}
export interface KritaAdapterOptions extends KritaRuntimeOptions { buildId: string; evidenceDirectory: string }

export class KritaAdapter implements NativeAdapter {
  readonly target = KRITA_TARGET;
  readonly evidenceKind = 'native' as const;
  readonly catalog = KRITA_CATALOG;
  private readonly runtime: KritaRuntime;
  private lane: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private last?: ObservationContext;
  private activeObserver?: AbortController;
  private activeNative?: AbortController;
  private resetPending = false;
  private ownerRun?: string;
  private recoveryRequired = false;
  private generationFloor = -1;
  private lastResetIdentity?: ObservationContext;
  private resetReceipt?: Awaited<ReturnType<KritaRuntime['reset']>>;
  private resetPromise?: Promise<NativeResetResult>;
  private artifacts: EvidenceArtifact[] = [];
  private diagnosticArtifacts: DiagnosticArtifact[] = [];
  constructor(private readonly options: KritaAdapterOptions) {
    if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(options.buildId)) throw new Error('KRITA_INVALID_BUILD_ID');
    assertNoSymlinkPath(options.evidenceDirectory);
    this.options = { ...options, evidenceDirectory: path.resolve(options.evidenceDirectory) };
    this.runtime = new KritaRuntime(options);
    if (this.options.evidenceDirectory === this.runtime.sessionRoot || this.options.evidenceDirectory.startsWith(`${this.runtime.sessionRoot}/`))
      throw new Error('KRITA_EVIDENCE_INSIDE_SESSION');
  }
  preflight() { return this.runtime.preflight(); }
  getBaselineSnapshot() { return this.runtime.getBaselineSnapshot(); }
  inspectReset() {
    return this.enqueue(async () => {
      if (this.resetPending || this.ownerRun || !this.lastResetIdentity) throw new Error('KRITA_RESET_NOT_COMPLETED');
      const observation = await this.runtime.inspectReset();
      const evidenceRefs = await this.evidence('independent-reset-inspection', this.lastResetIdentity, observation);
      return { ...observation, evidenceRefs };
    });
  }
  getEvidenceArtifacts(): EvidenceArtifact[] { return structuredClone(this.artifacts); }
  /** Failure diagnostics are never native acceptance or task evidence. */
  getDiagnosticArtifacts(): DiagnosticArtifact[] { return structuredClone(this.diagnosticArtifacts); }
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
    const id = `krita:${randomUUID()}`, file = path.join(this.options.evidenceDirectory, `${id.slice(6)}.json`);
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
  private async saveFailureDiagnostic(context: ObservationContext, error: unknown): Promise<void> {
    // Capture before coordinator reset removes the owned session. Diagnostic I/O
    // is best-effort and must never replace the original command/reset failure.
    try {
      const observation = await this.runtime.getDiagnostics();
      const id = `krita-diagnostic:${randomUUID()}`;
      const file = path.join(this.options.evidenceDirectory, `${id.replace(':', '-')}.json`);
      const errorCode = diagnosticCode(error instanceof Error ? error.message : 'KRITA_BRIDGE_FAILED');
      const bytes = JSON.stringify({ version: 1, diagnosticOnly: true, id,
        buildId: this.options.buildId, runId: context.runId, requestId: context.requestId,
        generation: context.generation, observedAt: new Date().toISOString(), errorCode, observation }, null, 2) + '\n';
      assertNoSymlinkPath(this.options.evidenceDirectory);
      await mkdir(this.options.evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      this.diagnosticArtifacts.push({ id, path: file, sha256: createHash('sha256').update(bytes).digest('hex'),
        buildId: this.options.buildId, runId: context.runId, diagnosticOnly: true });
    } catch { /* Keep original failure and recovery latch; no fabricated evidence. */ }
  }
  apply(value: NativePatch, input: PlannerRequest, sourceContext: CommitContext): Promise<void> {
    if (this.resetPending) throw new Error('KRITA_RESET_PENDING');
    if (this.recoveryRequired || sourceContext.generation <= this.generationFloor) throw new Error('KRITA_RESET_REQUIRED');
    // Snapshot before the queued wait; callers cannot mutate an already validated patch.
    const request = assertKritaRequest(structuredClone(input));
    const patch = validatePatch(structuredClone(value), request);
    if (sourceContext.runId !== request.runId || sourceContext.requestId !== request.requestId) throw new Error('KRITA_CONTEXT_MISMATCH');
    return this.enqueue(async () => {
      const controller = new AbortController(); this.activeNative = controller;
      const context: CommitContext = { ...sourceContext, signal: AbortSignal.any([sourceContext.signal, controller.signal]),
        isCurrent: () => !this.resetPending && sourceContext.isCurrent() };
      try {
      assertCurrent(context);
      if (this.resetPending) throw new Error('KRITA_RESET_PENDING');
      if (this.recoveryRequired || context.generation <= this.generationFloor ||
          (this.ownerRun && this.ownerRun !== context.runId) ||
          (this.last && this.last.generation > context.generation)) throw new Error('KRITA_RESET_REQUIRED');
      this.ownerRun = context.runId;
      const hello = await this.runtime.start(context);
      assertCurrent(context);
      await this.runtime.command('apply', context, patch.operations);
      assertCurrent(context);
      this.last = { runId: context.runId, requestId: context.requestId, generation: context.generation };
      await this.evidence('native-apply-acknowledgement', this.last, { hello, baseline: this.runtime.getBaselineSnapshot() });
      assertCurrent(context);
      } catch (error) { this.recoveryRequired = true; await this.saveFailureDiagnostic(context, error); throw error; }
      finally { this.activeNative = undefined; }
    });
  }
  readback(sourceContext: CommitContext): Promise<NativeReadback> {
    if (this.resetPending) throw new Error('KRITA_RESET_PENDING');
    if (this.recoveryRequired) throw new Error('KRITA_RESET_REQUIRED');
    return this.enqueue(async () => {
      const controller = new AbortController(); this.activeNative = controller;
      const context: CommitContext = { ...sourceContext, signal: AbortSignal.any([sourceContext.signal, controller.signal]),
        isCurrent: () => !this.resetPending && sourceContext.isCurrent() };
      try {
      assertCurrent(context);
      if (this.recoveryRequired || !this.matches(context)) throw new Error('KRITA_READBACK_IDENTITY');
      const observed = NativeReadbackSchema.parse(await this.runtime.command('readback', context));
      assertCurrent(context);
      if (observed.requestId !== context.requestId) throw new Error('KRITA_READBACK_IDENTITY');
      // Actual values remain actual even on mismatch; coordinator compares against desired state.
      observed.evidenceRefs = await this.evidence('native-readback', context, observed);
      assertCurrent(context);
      return observed;
      } catch (error) { await this.saveFailureDiagnostic(context, error); throw error; }
      finally { this.activeNative = undefined; }
    });
  }
  observe(input: ObservationContext): Promise<KritaObservation> {
    const identity = { runId: input.runId, requestId: input.requestId, generation: input.generation };
    return this.enqueue(async () => {
      if (this.recoveryRequired) throw new Error('KRITA_RESET_REQUIRED');
      if (!this.matches(identity)) throw new Error('KRITA_OBSERVATION_STALE');
      const controller = new AbortController(); this.activeObserver = controller;
      const context: CommitContext = { ...identity, signal: controller.signal, isCurrent: () => this.matches(identity) };
      try {
        const observation = await this.runtime.command<KritaObservation>('observe', context);
        assertCurrent(context);
        observation.evidenceRefs = await this.evidence('native-task-observation', identity, observation);
        assertCurrent(context); return observation;
      } catch (error) { await this.saveFailureDiagnostic(context, error); throw error; }
      finally { this.activeObserver = undefined; }
    });
  }
  reset(identity: { runId: string; generation: number }): Promise<NativeResetResult> {
    if (this.ownerRun && this.ownerRun !== identity.runId) throw new Error('KRITA_RESET_IDENTITY');
    if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) throw new Error('KRITA_BAD_GENERATION');
    if (this.resetPromise) return this.resetPromise;
    this.generationFloor = Math.max(this.generationFloor, identity.generation);
    this.resetPending = true; this.activeNative?.abort(); this.activeObserver?.abort();
    const context: CommitContext = { ...identity, requestId: `${identity.runId}:native-reset`,
      signal: new AbortController().signal, isCurrent: () => this.resetPending };
    this.resetPromise = this.enqueue(async () => {
      const restored = this.resetReceipt ?? await this.runtime.reset(context);
      this.resetReceipt = restored;
      const evidenceRefs = await this.evidence('native-reset', context, restored);
      this.lastResetIdentity = { runId: context.runId, requestId: context.requestId, generation: context.generation };
      this.last = undefined; this.ownerRun = undefined; this.recoveryRequired = false; this.resetReceipt = undefined;
      return { targetClosed: restored.targetClosed, preferencesRestored: restored.preferencesRestored,
        visitorArtifactsCleared: restored.visitorArtifactsCleared, evidenceRefs };
    }).catch(async error => { this.recoveryRequired = true; await this.saveFailureDiagnostic(context, error); throw error; })
      .finally(() => { this.resetPending = false; this.resetPromise = undefined; });
    return this.resetPromise;
  }
}
export function createKritaAdapter(options: KritaAdapterOptions): KritaAdapter { return new KritaAdapter(options); }
