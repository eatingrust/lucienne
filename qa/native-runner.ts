import type { Capability, ChatIntent, Operation, PlannerRequest } from '../contracts/index.js';
import { verifyArtifacts } from './artifacts.ts';
import type { RunRecorder } from './capture.ts';
import { createClosureBackoff } from './closure-backoff.ts';
import { validateNativeTask, type BlenderTaskState, type NativeTaskSnapshot } from './native-checks.ts';
import { verifyBlenderBindingEvidence, verifyBlenderObservationEvidence, verifyBlenderReadbackEvidence } from './native-evidence.ts';
import { runObservedQA, type ObservedIdentity, type ObservedQAState, type ObservedQARuntime,
  type ObservedRunOptions, type ObservedRunResult } from './observed-runner.ts';

export type NativeQAAction = 'select' | 'move';
export interface RelaunchClosure {
  targetClosed: boolean; baselineCompared: boolean; visitorStateCleared: boolean;
  recentsCleared: boolean; sessionAbsent: boolean; evidenceRefs: string[];
}
export interface NativeQARuntime extends ObservedQARuntime<NativeQAAction, ObservedQAState> {
  /** Independent inspection after the ordinary app has been closed. A failed or
   * false inspection holds the desktop slot until closure can be confirmed. */
  inspectRelaunchClosed(): Promise<RelaunchClosure>;
}
export interface NativeRunOptions extends Omit<ObservedRunOptions<NativeQAAction, ObservedQAState>,
  'runtime' | 'tasks' | 'validateTask' | 'chatRecipe' | 'verifyCommit' | 'verifyObservation' | 'verifyCapture'> {
  runtime: NativeQARuntime;
  /** Blender adapter's projectBlenderTaskObservation; the runner never invents native IDs. */
  projectObservation(value: unknown): NativeTaskSnapshot<BlenderTaskState>;
  /** Blender adapter's projectBlenderReadback validates the full native operation set. */
  projectReadback(operations: readonly Operation[], catalog: readonly Capability[]): Operation[];
  /** Existing registered scenario.chat; explicit overrides remain host-owned. */
  chat(intent: ChatIntent, currentOperations: readonly Operation[]): {
    intent: ChatIntent; instruction: string; explicit?: PlannerRequest['explicit'];
  };
}
const fail = (code: string): never => { throw new Error(code); };
const tasks: readonly (readonly [NativeQAAction, string])[] = [
  ['select', 'Select a different practice mesh in the native 3D view. Leave every object in place.'],
  ['move', 'Move the selected practice mesh and confirm the operation. Leave all other objects unchanged.'],
];
const keys: Record<ChatIntent, string> = {
  'move-key-panels': 'panel-side', 'enlarge-work-area': 'work-area', 'simplify-tools': 'tool-density',
};
const closed = (value: RelaunchClosure): boolean => value.targetClosed === true && value.baselineCompared === true
  && value.visitorStateCleared === true && value.recentsCleared === true && value.sessionAbsent === true;

/** Approved Photoshop → Blender collection seam. host supplies the real
 * coordinator, serialized desktop and operator callbacks. It does not select a
 * route, launch an app on import, or turn fixture/prepared evidence into a pass.
 * The independent audit/CLI still decides acceptance from the saved capture. */
export async function runNativeQA(options: NativeRunOptions): Promise<ObservedRunResult> {
  const selection = structuredClone(options.selection);
  const catalog = structuredClone([...options.runtime.adapter.catalog]);
  const profiles: Record<string, string> = { 'photoshop-essentials': 'essentials',
    'photoshop-retoucher': 'retoucher', 'photoshop-collage': 'collage' };
  if (selection.target.appId !== 'blender' || selection.source.sourceApp !== 'photoshop'
    || !Object.hasOwn(profiles, selection.source.profileId) || profiles[selection.source.profileId] !== selection.source.personaId
    || selection.scenarioId !== `${selection.source.profileId}-to-blender`) fail('WRONG_NATIVE_QA_SCENARIO');
  if (!selection.bindingApplicability || !selection.evidenceRefs?.length) fail('BLENDER_QA_POLICY_REQUIRED');
  if (typeof options.projectObservation !== 'function' || typeof options.projectReadback !== 'function' || typeof options.chat !== 'function'
    || typeof options.runtime.inspectRelaunchClosed !== 'function') fail('NATIVE_QA_HOOK_REQUIRED');
  const policySelection = { ...selection, evidenceRefs: selection.evidenceRefs! };
  let scene: string | undefined;
  let relaunchAttempted = false, closureRechecked = false;
  let closure: RelaunchClosure | undefined;
  const adopt = async (recorder: RunRecorder) => {
    await recorder.adoptArtifacts(await options.runtime.adapter.getEvidenceArtifacts(), options.runtime.evidenceRoot);
    if (options.runtime.getEvidenceArtifacts)
      await recorder.adoptArtifacts(await options.runtime.getEvidenceArtifacts(), options.runtime.evidenceRoot);
  };
  const verifyObservation = async (recorder: RunRecorder, identity: ObservedIdentity, raw: ObservedQAState) => {
    await adopt(recorder);
    await verifyBlenderObservationEvidence(recorder, identity, raw, options.projectObservation);
    const projected = options.projectObservation(raw);
    if (!/^blender:scene:[a-f0-9]{64}$/.test(projected.contextId)) fail('BLENDER_QA_SCENE_ID_REQUIRED');
    if (scene !== undefined && projected.contextId !== scene) fail('BLENDER_QA_SCENE_CHANGED');
    scene ??= projected.contextId;
  };
  const runtime: NativeQARuntime = {
    ...options.runtime,
    async ordinaryRelaunch(context) {
      relaunchAttempted = true;
      let value: Awaited<ReturnType<NativeQARuntime['ordinaryRelaunch']>> | undefined;
      let primary: unknown;
      try { value = await options.runtime.ordinaryRelaunch(context); } catch (error) { primary = error; }
      // An old completed session reset cannot close this separate launch. Keep
      // ownership even after cancellation until independent closure is known.
      const waitForClosure = createClosureBackoff(options.scheduler);
      for (;;) {
        try {
          const observed = await options.runtime.inspectRelaunchClosed();
          if (closed(observed)) { closure = structuredClone(observed); break; }
        } catch { /* Unknown closure is not permission to release the desktop. */ }
        closureRechecked = true;
        await waitForClosure();
      }
      if (primary !== undefined) throw primary;
      if (closureRechecked) fail('ORDINARY_RELAUNCH_CLOSURE_RECHECKED');
      return value!;
    },
  };
  return runObservedQA({ ...options, selection, runtime, tasks,
    validateTask(action, before, after, evidenceRefs) {
      const checked = validateNativeTask({ target: 'blender', action,
        before: options.projectObservation(before), after: options.projectObservation(after) });
      if (checked.observation) checked.observation.evidenceRefs = [...new Set([...checked.observation.evidenceRefs, ...evidenceRefs])];
      return checked;
    },
    chatRecipe(intent, currentOperations, actualCatalog) {
      const input = options.chat(intent, structuredClone(currentOperations));
      const key = keys[intent], explicit = input.explicit?.filter(value => value.key === key) ?? [];
      const capabilities = actualCatalog.filter(value => value.preferenceKey === key);
      if (input.intent !== intent || explicit.length !== 1 || capabilities.length !== 1
        || !capabilities[0].values.includes(explicit[0].value)) fail('BLENDER_QA_CHAT_OVERRIDE_REQUIRED');
      return { ...input, expectedOperation: { capabilityId: capabilities[0].id, value: explicit[0].value } };
    },
    async verifyCommit(recorder) {
      await adopt(recorder);
      await verifyBlenderBindingEvidence(recorder, policySelection, catalog);
      const identity = recorder.latestCommittedIdentity();
      const commit = recorder.snapshot().commits.at(-1)!;
      await verifyBlenderReadbackEvidence(recorder, identity, commit.readback, options.projectReadback, catalog);
      await verifyObservation(recorder, identity, await options.runtime.adapter.observe(identity));
    },
    verifyObservation,
    async verifyCapture(recorder) {
      if (relaunchAttempted && closure) {
        await recorder.writeObservation(`qa:${recorder.runId}:ordinary-relaunch-closed`, closure);
      }
      const capture = recorder.snapshot();
      const checks = await verifyArtifacts(recorder.directory, capture.artifacts, capture);
      const verified = new Set(checks.filter(check => check.status === 'pass').map(check => check.id));
      const refs = [
        ...capture.events.flatMap(event => event.evidenceRefs),
        ...capture.commits.flatMap(commit => commit.readback.evidenceRefs),
        ...capture.tasks.flatMap(task => task.evidenceRefs),
        ...(capture.reset ? [...capture.reset.native.evidenceRefs, ...capture.reset.desktop.evidenceRefs, ...capture.reset.evidenceRefs] : []),
        ...(capture.relaunch?.evidenceRefs ?? []), ...(closure?.evidenceRefs ?? []),
      ];
      if (checks.some(check => check.status !== 'pass') || refs.some(ref => !verified.has(ref))) fail('NATIVE_QA_EVIDENCE_UNVERIFIED');
      if (relaunchAttempted && (!closure || !closure.evidenceRefs.length)) fail('ORDINARY_RELAUNCH_CLOSURE_UNVERIFIED');
    },
  });
}
