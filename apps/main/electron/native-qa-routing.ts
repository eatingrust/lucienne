import { isDeepStrictEqual } from 'node:util';
import type { RuntimeScenario } from '../../../contracts/bridge.js';
import type { DesktopPort, PlannerPort } from '../../../contracts/ports.js';
import type { Selection } from '../../../core/session.js';
import type { KritaAdapter } from '../../../adapters/krita/index.js';
import { projectBlenderTaskObservation, type BlenderAdapter } from '../../../adapters/blender/index.js';
import { projectBlenderReadback } from '../../../adapters/blender/catalog.js';
import type { EvidenceArtifact } from '../../../qa/artifacts.js';
import type { NativeRunOptions, RelaunchClosure } from '../../../qa/native-runner.js';
import type { NativeAdapterRegistry, RegisteredNativeScenario } from './adapter-registry.js';
import { readOrdinaryRelaunchEvidence, type NativeQAAttempt, type OrdinaryRelaunchObligation } from './native-qa.js';

/** Collection support is narrower than the full product matrix. Keep every row
 * visible, but never route an unsupported target into a different app's runner. */
export function supportsNativeQA(selection: Pick<Selection, 'source' | 'target' | 'scenarioId'>): boolean {
  if (selection.source.sourceApp !== 'photoshop'
    || selection.scenarioId !== `${selection.source.profileId}-to-${selection.target.appId}`) return false;
  const personas: Record<string, string> = { 'photoshop-essentials': 'essentials',
    'photoshop-retoucher': 'retoucher', 'photoshop-collage': 'collage' };
  if (personas[selection.source.profileId] !== selection.source.personaId) return false;
  return selection.target.appId === 'blender'
    || (selection.target.appId === 'krita' && selection.source.profileId === 'photoshop-collage');
}
export function nativeQACatalog(rows: readonly RuntimeScenario[]): RuntimeScenario[] {
  return rows.map(row => supportsNativeQA(row) || !row.selectable ? row : {
    ...row, selectable: false, reasonCode: 'QA_RUNNER_UNAVAILABLE',
    reason: 'Native QA collection is available for Photoshop collage → Krita and Photoshop → Blender.',
    initialModes: [],
  });
}
/** Setup readiness only exposes the selector. A particular target is not ready
 * until its own preflight has completed and the host publishes that selection. */
export function nativeQASelectionAvailable(setupReady: boolean, registry?: NativeAdapterRegistry): boolean {
  return setupReady && !!registry?.list().some(row => row.selectable && supportsNativeQA(row));
}
type QAPlannerFor = (scenario: RegisteredNativeScenario) => PlannerPort;
export async function prepareNativeQAScenario(registry: NativeAdapterRegistry, scenarioId: string, plannerFor: QAPlannerFor) {
  const row = registry.list().find(candidate => candidate.scenarioId === scenarioId);
  if (!row?.selectable || !supportsNativeQA(row)) throw new Error('QA_SCENARIO_UNAVAILABLE');
  const scenario = registry.create(scenarioId);
  if (typeof scenario.adapter.preflight !== 'function') throw new Error('QA_PREFLIGHT_REQUIRED');
  await scenario.adapter.preflight();
  return { scenario, planner: plannerFor(scenario) };
}
/** A target-specific default failure must not disable independently usable QA
 * routes. Provider/config setup happens before this function and is not caught. */
export async function prepareDefaultNativeQA(registry: NativeAdapterRegistry, plannerFor: QAPlannerFor) {
  try {
    const selected = await prepareNativeQAScenario(registry, 'photoshop-collage-to-krita', plannerFor);
    return { status: 'ready' as const, ...selected };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return { status: 'unavailable' as const,
      code: /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'QA_DEFAULT_TARGET_UNAVAILABLE' };
  }
}

interface RoutingOptions {
  scenario: RegisteredNativeScenario;
  buildId: string; runId: string; outputRoot: string; evidenceRoot: string;
  desktop: DesktopPort; initialPlanner: PlannerPort; chatPlanner: PlannerPort;
  createCoordinator: NativeRunOptions['createCoordinator'];
  onSnapshot: NonNullable<NativeRunOptions['runtime']['onSnapshot']>;
  getHostArtifacts(): EvidenceArtifact[];
  addHostArtifacts(artifacts: EvidenceArtifact[]): void;
  waitForOperator(instruction: string, signal?: AbortSignal): Promise<void>;
  showOperator(): void;
  ordinaryRelaunch: OrdinaryRelaunchObligation;
}

/** Bind every callback to the registered adapter now, before any later selection
 * or visitor reset can clear the host's current scenario references. */
export function createNativeQAAttempt(options: RoutingOptions): NativeQAAttempt {
  const { scenario } = options;
  if (!supportsNativeQA(scenario.selection) || !scenario.row.selectable)
    throw new Error('QA_SCENARIO_UNAVAILABLE');
  const candidate = scenario.adapter;
  if (candidate.evidenceKind !== 'native' || !isDeepStrictEqual(candidate.target, scenario.selection.target)
    || !isDeepStrictEqual(candidate.catalog, scenario.row.catalog)
    || ['observe', 'inspectReset', 'isQuiescent', 'getEvidenceArtifacts'].some(method =>
      typeof Reflect.get(candidate, method) !== 'function')) throw new Error('QA_ADAPTER_HOOK_REQUIRED');
  // The registry constructs these from trusted bundled modules; the runner still
  // validates every observation and exact artifact byte before accepting it.
  const adapter = candidate as KritaAdapter | BlenderAdapter;
  const label = scenario.selection.target.appId === 'krita' ? 'Krita' : 'Blender';
  const inspectClosure = async (): Promise<RelaunchClosure> => {
    const observed = await adapter.inspectReset();
    if (!await adapter.isQuiescent()) throw new Error('QA_ADAPTER_NOT_QUIESCENT');
    return { targetClosed: observed.targetClosed, baselineCompared: observed.baselineCompared,
      visitorStateCleared: observed.visitorStateCleared, recentsCleared: observed.recentsCleared,
      sessionAbsent: observed.sessionAbsent, evidenceRefs: [...observed.evidenceRefs] };
  };
  const runtime = {
    adapter, desktop: options.desktop, initialPlanner: options.initialPlanner, chatPlanner: options.chatPlanner,
    evidenceRoot: options.evidenceRoot, getEvidenceArtifacts: () => options.getHostArtifacts(),
    onSnapshot: options.onSnapshot,
    performTask: (_action: string, instruction: string, context?: { signal: AbortSignal }) =>
      options.waitForOperator(instruction, context?.signal),
    inspectReset: async () => {
      const first = await adapter.inspectReset();
      await new Promise(resolve => setTimeout(resolve, 300));
      const second = await adapter.inspectReset();
      const quiet = await adapter.isQuiescent();
      return { baselineCompared: first.baselineCompared && second.baselineCompared,
        visitorStateCleared: first.visitorStateCleared && second.visitorStateCleared,
        recentsCleared: first.recentsCleared && second.recentsCleared,
        lateWritesObserved: !quiet || !first.targetClosed || !second.targetClosed || !first.sessionAbsent
          || !second.sessionAbsent || !isDeepStrictEqual(first.current, second.current),
        evidenceRefs: [...first.evidenceRefs, ...second.evidenceRefs] };
    },
    ordinaryRelaunch: async (context?: { signal: AbortSignal }) => {
      options.ordinaryRelaunch.begin(label, inspectClosure);
      options.showOperator();
      await options.waitForOperator(`Open ${label} normally without session overrides. Independently inspect its default workspace, shortcuts and recents, close it, and save ordinary-relaunch.json with the actual UI artifacts before continuing.`, context?.signal);
      const observed = await readOrdinaryRelaunchEvidence(options.evidenceRoot, options);
      options.addHostArtifacts(observed.artifacts);
      await options.ordinaryRelaunch.verifyClosed();
      return observed.receipt;
    },
  };
  const common = { buildId: options.buildId, runId: options.runId, outputRoot: options.outputRoot,
    createCoordinator: options.createCoordinator };
  if (scenario.selection.target.appId === 'krita') return { target: 'krita', options: { ...common,
    source: structuredClone(scenario.selection.source), scenarioId: scenario.selection.scenarioId,
    runtime: { ...runtime, adapter: adapter as KritaAdapter } } };
  if (!scenario.selection.bindingApplicability || !scenario.selection.evidenceRefs?.length)
    throw new Error('BLENDER_QA_POLICY_REQUIRED');
  return { target: 'blender', options: { ...common, selection: structuredClone(scenario.selection),
    projectObservation: projectBlenderTaskObservation, projectReadback: projectBlenderReadback,
    chat: (intent, operations) => scenario.chat(intent, operations),
    runtime: { ...runtime, adapter: adapter as BlenderAdapter,
      inspectRelaunchClosed: () => options.ordinaryRelaunch.pending
        ? options.ordinaryRelaunch.verifyClosed() : inspectClosure() } } };
}
