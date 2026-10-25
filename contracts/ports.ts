import { z } from 'zod';
import { OperationSchema, type Capability, type NativePatch, type PlannerRequest, type PlannerResult, type Target } from './index.js';
const evidenceRefs = z.array(z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/)).max(32);
export const NativeReadbackSchema = z.strictObject({
  requestId: z.string().min(1).max(160), targetVisible: z.boolean(), interactive: z.boolean(),
  operations: z.array(OperationSchema).max(64), evidenceRefs,
});
export const NativeResetResultSchema = z.strictObject({
  targetClosed: z.boolean(), preferencesRestored: z.boolean(), visitorArtifactsCleared: z.boolean(), evidenceRefs,
});
export const DesktopResultSchema = z.strictObject({ desktopVisible: z.boolean(), evidenceRefs });

export interface PlannerPort {
  readonly provider: string;
  readonly mode: 'live' | 'prepared' | 'replay' | 'simulated';
  plan(request: PlannerRequest, context: { signal: AbortSignal; onProgress: () => void }): Promise<PlannerResult>;
}
export interface CommitContext {
  readonly runId: string;
  readonly requestId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  /** Check immediately before EVERY native mutation and after asynchronous waits. */
  isCurrent(): boolean;
}
export interface NativeReadback {
  requestId: string;
  targetVisible: boolean;
  interactive: boolean;
  // Adapter reports actual values read from the target, not the requested patch.
  operations: NativePatch['operations'];
  evidenceRefs: string[];
}
export interface NativeResetResult {
  targetClosed: boolean;
  preferencesRestored: boolean;
  visitorArtifactsCleared: boolean;
  evidenceRefs: string[];
}
export interface NativeAdapter {
  readonly target: Target;
  readonly evidenceKind: 'native' | 'fixture';
  readonly catalog: readonly Capability[];
  /** All writes are inside these methods. No detached writer may outlive settlement. */
  apply(patch: NativePatch, request: PlannerRequest, context: CommitContext): Promise<void>;
  readback(context: CommitContext): Promise<NativeReadback>;
  /** Called only after in-flight apply/readback settles. Must restore even an aborted partial apply. */
  reset(context: { runId: string; generation: number }): Promise<NativeResetResult>;
}
export interface DesktopPort {
  /** Native implementation must close/hide Lucienne and verify the dedicated account desktop. */
  returnToDesktop(): Promise<{ desktopVisible: boolean; evidenceRefs: string[] }>;
}
