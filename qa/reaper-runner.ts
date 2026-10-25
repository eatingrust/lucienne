import { isDeepStrictEqual } from 'node:util';
import type { ChatIntent, Operation, PlannerRequest } from '../contracts/index.js';
import type { EvidenceArtifact } from './artifacts.ts';
import { verifyArtifacts } from './artifacts.ts';
import type { RunRecorder } from './capture.ts';
import { createClosureBackoff } from './closure-backoff.ts';
import { validateNativeTask, type NativeTaskSnapshot, type NativeTimelineClip, type PlaybackTaskState } from './native-checks.ts';
import type { RelaunchClosure } from './native-runner.ts';
import { runObservedQA, type ObservedIdentity, type ObservedQAAdapter, type ObservedQAState, type ObservedQARuntime,
  type ObservedRunOptions, type ObservedRunResult } from './observed-runner.ts';
import { verifyReaperBindingEvidence, verifyReaperObservationEvidence, verifyReaperReadbackEvidence } from './reaper-evidence.ts';

export type ReaperQAAction = 'split' | 'trim' | 'play';
export interface ReaperQAAdapter extends ObservedQAAdapter<ObservedQAState> {
  /** Adapter retains receipts after reset; collect only this recorder's run. */
  getEvidenceArtifacts(runId?: string): EvidenceArtifact[] | Promise<EvidenceArtifact[]>;
}
export interface ReaperQARuntime extends ObservedQARuntime<ReaperQAAction, ObservedQAState> {
  adapter: ReaperQAAdapter;
  /** Host combines independent desktop, recents, visitor-state and baseline
   * evidence. The adapter's partial inspectReset alone cannot supply this. */
  inspectRelaunchClosed(): Promise<RelaunchClosure>;
}
export interface ReaperRunOptions extends Omit<ObservedRunOptions<ReaperQAAction, ObservedQAState>,
  'runtime' | 'tasks' | 'validateTask' | 'chatRecipe' | 'verifyCommit' | 'verifyObservation' | 'verifyCapture'> {
  runtime: ReaperQARuntime;
  /** REAPER adapter's actual projectReaperTaskObservation, supplied by trusted host code. */
  projectObservation(value: unknown): NativeTaskSnapshot<PlaybackTaskState>;
  /** REAPER adapter's REAPER_NATIVE_SEMANTICS; declarations are checked against these bytes. */
  nativeSemantics: Readonly<Record<string, string>>;
  chat(intent: ChatIntent, currentOperations: readonly Operation[]): {
    intent: ChatIntent; instruction: string; explicit?: PlannerRequest['explicit'];
  };
}

function fail(code: string): never { throw new Error(code); }
const tasks: readonly (readonly [ReaperQAAction, string])[] = [
  ['split', 'Split one practice audio item at an interior point using the native split action. Preserve all other items.'],
  ['trim', 'Trim one edge of a practice audio item without moving its remaining audio or changing other items.'],
  ['play', 'Start native audio playback and let the playhead advance. Leave all audio items unchanged.'],
];
const keys: Record<ChatIntent, string> = {
  'move-key-panels': 'panel-side', 'enlarge-work-area': 'work-area', 'simplify-tools': 'tool-density',
};
const closed = (value: RelaunchClosure): boolean => value.targetClosed === true && value.baselineCompared === true
  && value.visitorStateCleared === true && value.recentsCleared === true && value.sessionAbsent === true;
const clips = (value: readonly NativeTimelineClip[]): NativeTimelineClip[] => structuredClone([...value]).sort((a, b) => a.id.localeCompare(b.id));

/** Existing approved timeline-source → REAPER collection only. No app launches
 * on import. host provides the serialized native desktop and real user gestures;
 * a saved capture still needs independent audit and cannot promote fixtures. */
export async function runReaperQA(options: ReaperRunOptions): Promise<ObservedRunResult> {
  const selection = structuredClone(options.selection);
  const adapter = options.runtime.adapter;
  const catalog = structuredClone([...adapter.catalog]);
  const nativeSemantics = structuredClone(options.nativeSemantics);
  // profile service's exact approved profile/persona pairs are pinned below.
  const profiles: Record<string, { source: string; persona: string }> = {
    'premiere-editing': { source: 'premiere', persona: 'editing' },
    'premiere-dialogue': { source: 'premiere', persona: 'dialogue' },
    'premiere-color': { source: 'premiere', persona: 'color' },
    'after-effects-standard': { source: 'after-effects', persona: 'standard' },
    'after-effects-motion': { source: 'after-effects', persona: 'motion' },
    'after-effects-compositor': { source: 'after-effects', persona: 'compositor' },
    'resolve-edit': { source: 'resolve', persona: 'edit' },
    'resolve-dialogue': { source: 'resolve', persona: 'dialogue' },
    'resolve-color': { source: 'resolve', persona: 'color' },
  };
  const profile = profiles[selection.source.profileId];
  if (selection.target.appId !== 'reaper' || !profile || profile.source !== selection.source.sourceApp
    || profile.persona !== selection.source.personaId || selection.scenarioId !== `${selection.source.profileId}-to-reaper`)
    fail('WRONG_REAPER_QA_SCENARIO');
  if (!selection.bindingApplicability || !selection.evidenceRefs?.length) fail('REAPER_QA_POLICY_REQUIRED');
  if (typeof options.projectObservation !== 'function' || typeof options.chat !== 'function'
    || typeof options.runtime.inspectRelaunchClosed !== 'function' || !nativeSemantics || typeof nativeSemantics !== 'object')
    fail('REAPER_QA_HOOK_REQUIRED');
  const policySelection = { ...selection, evidenceRefs: selection.evidenceRefs };
  let currentRunId: string | undefined;
  let project: string | undefined, expectedClips: NativeTimelineClip[] | undefined;
  let awaitingTaskAfter = false;
  let relaunchAttempted = false, closureRechecked = false;
  let closure: RelaunchClosure | undefined;
  const runArtifacts = async (): Promise<EvidenceArtifact[]> => currentRunId === undefined ? []
    : (await adapter.getEvidenceArtifacts(currentRunId)).filter(artifact => artifact.runId === currentRunId);
  const hostArtifacts = async (): Promise<EvidenceArtifact[]> => currentRunId === undefined || !options.runtime.getEvidenceArtifacts ? []
    : (await options.runtime.getEvidenceArtifacts()).filter(artifact => artifact.runId === currentRunId);
  const adopt = async (recorder: RunRecorder) => {
    await recorder.adoptArtifacts(await runArtifacts(), options.runtime.evidenceRoot);
    await recorder.adoptArtifacts(await hostArtifacts(), options.runtime.evidenceRoot);
  };
  const verifyObservation = async (recorder: RunRecorder, identity: ObservedIdentity, raw: ObservedQAState) => {
    await adopt(recorder);
    await verifyReaperObservationEvidence(recorder, identity, raw, options.projectObservation);
    const projected = options.projectObservation(raw);
    if (!projected.contextId.startsWith('reaper:')) fail('REAPER_QA_PROJECT_ID_REQUIRED');
    if (project !== undefined && projected.contextId !== project) fail('REAPER_QA_PROJECT_CHANGED');
    project ??= projected.contextId;
  };
  // Explicit forwarding keeps adapter/runtime prototype methods bound. Dynamic
  // getters allow the shared engine to detect an adapter scope mutation.
  const runtime: ReaperQARuntime = {
    adapter: {
      get target() { return adapter.target; },
      get catalog() { return adapter.catalog; },
      get evidenceKind() { return adapter.evidenceKind; },
      apply: (patch, request, context) => adapter.apply(patch, request, context),
      readback: context => adapter.readback(context),
      reset: context => adapter.reset(context),
      observe: identity => adapter.observe(identity),
      isQuiescent: () => adapter.isQuiescent(),
      getEvidenceArtifacts: runArtifacts,
    },
    desktop: options.runtime.desktop,
    initialPlanner: options.runtime.initialPlanner,
    chatPlanner: options.runtime.chatPlanner,
    performTask: (action, instruction, context) => options.runtime.performTask(action, instruction, context),
    inspectReset: () => options.runtime.inspectReset(),
    inspectRelaunchClosed: () => options.runtime.inspectRelaunchClosed(),
    evidenceRoot: options.runtime.evidenceRoot,
    getEvidenceArtifacts: hostArtifacts,
    ...(options.runtime.onEvent ? { onEvent: (event: Parameters<NonNullable<ReaperQARuntime['onEvent']>>[0]) => options.runtime.onEvent!(event) } : {}),
    ...(options.runtime.onSnapshot ? { onSnapshot: (snapshot: Parameters<NonNullable<ReaperQARuntime['onSnapshot']>>[0]) => options.runtime.onSnapshot!(snapshot) } : {}),
    async ordinaryRelaunch(context) {
      relaunchAttempted = true;
      let value: Awaited<ReturnType<ReaperQARuntime['ordinaryRelaunch']>> | undefined;
      let primary: unknown, failed = false;
      try { value = await options.runtime.ordinaryRelaunch(context); } catch (error) { failed = true; primary = error; }
      const waitForClosure = createClosureBackoff(options.scheduler);
      for (;;) {
        try {
          const observed = await options.runtime.inspectRelaunchClosed();
          if (closed(observed)) { closure = structuredClone(observed); break; }
        } catch { /* An unknown separate launch keeps desktop ownership held. */ }
        closureRechecked = true;
        await waitForClosure();
      }
      if (failed) throw primary;
      if (closureRechecked) fail('ORDINARY_RELAUNCH_CLOSURE_RECHECKED');
      return value!;
    },
  };
  return runObservedQA({ ...options, selection, runtime, tasks,
    createCoordinator(factory) {
      currentRunId = factory.id();
      return options.createCoordinator(factory);
    },
    validateTask(action, before, after, evidenceRefs) {
      const prior = options.projectObservation(before), next = options.projectObservation(after);
      if (expectedClips !== undefined && !isDeepStrictEqual(clips(prior.taskState.clips), expectedClips))
        fail('REAPER_QA_CONTENT_CHANGED');
      const checked = validateNativeTask({ target: 'reaper', action, before: prior, after: next });
      if (checked.status === 'pass') expectedClips = clips(next.taskState.clips);
      if (checked.observation) checked.observation.evidenceRefs = [...new Set([...checked.observation.evidenceRefs, ...evidenceRefs])];
      return checked;
    },
    chatRecipe(intent, currentOperations, actualCatalog) {
      const input = options.chat(intent, structuredClone(currentOperations));
      const explicit = input.explicit?.filter(value => value.key === keys[intent]) ?? [];
      const capabilities = actualCatalog.filter(value => value.preferenceKey === keys[intent]);
      if (input.intent !== intent || explicit.length !== 1 || capabilities.length !== 1
        || !capabilities[0].values.includes(explicit[0].value)) fail('REAPER_QA_CHAT_OVERRIDE_REQUIRED');
      return { ...input, expectedOperation: { capabilityId: capabilities[0].id, value: explicit[0].value } };
    },
    async verifyCommit(recorder) {
      await adopt(recorder);
      await verifyReaperBindingEvidence(recorder, policySelection, catalog, nativeSemantics);
      const identity = recorder.latestCommittedIdentity(), commit = recorder.snapshot().commits.at(-1)!;
      await verifyReaperReadbackEvidence(recorder, identity, commit.readback);
      const raw = structuredClone(await adapter.observe(identity));
      await verifyObservation(recorder, identity, raw);
      const actual = clips(options.projectObservation(raw).taskState.clips);
      if (expectedClips !== undefined && !isDeepStrictEqual(actual, expectedClips)) fail('REAPER_QA_CONTENT_CHANGED');
      expectedClips = actual;
    },
    async verifyObservation(recorder, identity, raw) {
      await verifyObservation(recorder, identity, raw);
      // The shared engine calls this before and after each gesture. Reject
      // unexpected edits before permitting the next operator action as well.
      if (!awaitingTaskAfter && expectedClips !== undefined
        && !isDeepStrictEqual(clips(options.projectObservation(raw).taskState.clips), expectedClips))
        fail('REAPER_QA_CONTENT_CHANGED');
      awaitingTaskAfter = !awaitingTaskAfter;
    },
    async verifyCapture(recorder) {
      if (relaunchAttempted && closure) await recorder.writeObservation(`qa:${recorder.runId}:ordinary-relaunch-closed`, closure);
      const capture = recorder.snapshot(), checks = await verifyArtifacts(recorder.directory, capture.artifacts, capture);
      const verified = new Set(checks.filter(check => check.status === 'pass').map(check => check.id));
      const refs = [
        ...capture.events.flatMap(event => event.evidenceRefs), ...capture.commits.flatMap(commit => commit.readback.evidenceRefs),
        ...capture.tasks.flatMap(task => task.evidenceRefs),
        ...(capture.reset ? [...capture.reset.native.evidenceRefs, ...capture.reset.desktop.evidenceRefs, ...capture.reset.evidenceRefs] : []),
        ...(capture.relaunch?.evidenceRefs ?? []), ...(closure?.evidenceRefs ?? []),
      ];
      if (checks.some(check => check.status !== 'pass') || refs.some(ref => !verified.has(ref))) fail('REAPER_QA_EVIDENCE_UNVERIFIED');
      if (relaunchAttempted && (!closure || !closure.evidenceRefs.length)) fail('ORDINARY_RELAUNCH_CLOSURE_UNVERIFIED');
    },
  });
}
