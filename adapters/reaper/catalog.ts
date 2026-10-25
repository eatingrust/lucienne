import {
  validateRequest,
  resolveBindingRequirements,
  SourceProfileSchema,
  type BindingApplicability,
  type Capability,
  type Operation,
  type PlannerRequest,
  type SourceApp,
  type SourceProfile,
} from '../../contracts/index.js';

export const REAPER_TARGET = Object.freeze({ appId: 'reaper' as const, adapterVersion: 'reaper-7.83-v1' });
/** Authored recipe provenance only; this is not native verification evidence. */
export const REAPER_BINDING_EVIDENCE = 'reaper:binding-recipes:7.83-v1';
export type ReaperSource = 'premiere' | 'after-effects' | 'resolve';
export interface ReaperBindingContext { scenarioId: string; source: SourceProfile }
export interface ReaperBindingSetup {
  catalog: readonly Capability[];
  bindingApplicability: BindingApplicability;
  evidenceRefs: string[];
}

// These are finite native recipes, not arbitrary ReaScript supplied by a planner.
// A source-specific catalog prevents two different actions from claiming Space.
const sourceBindings: Readonly<Record<ReaperSource, Readonly<Record<string, string>>>> = Object.freeze({
  premiere: Object.freeze({ select: 'V', 'razor-tool': 'C', 'play-pause': 'Space' }),
  'after-effects': Object.freeze({ select: 'V', pan: 'H', 'preview-toggle': 'Space' }),
  resolve: Object.freeze({ 'play-pause': 'Space', 'blade-tool': 'B', 'mark-in': 'I' }),
});
const common: Capability[] = [
  { id: 'reaper.layout.panel-side', kind: 'layout', preferenceKey: 'panel-side', values: ['left', 'right'] },
  { id: 'reaper.timeline.work-area', kind: 'timeline', preferenceKey: 'work-area', values: ['normal', 'large'] },
  { id: 'reaper.tool-layout.density', kind: 'tool-layout', preferenceKey: 'tool-density', values: ['full', 'simple'] },
];
const catalogs = Object.fromEntries(Object.entries(sourceBindings).map(([source, bindings]) => [source,
  Object.freeze([...common, ...Object.entries(bindings).map(([action, binding]): Capability => ({
    id: `reaper.binding.${action}`, kind: 'binding', bindingAction: action, values: [binding],
  }))].map(capability => Object.freeze({ ...capability, values: Object.freeze([...capability.values]) as unknown as string[] }))),
])) as Readonly<Record<ReaperSource, readonly Capability[]>>;

export function isReaperSource(source: SourceApp): source is ReaperSource {
  return source === 'premiere' || source === 'after-effects' || source === 'resolve';
}

/** Instantiate the native adapter with this same source-specific catalog. */
export function catalogForSource(source: SourceApp): readonly Capability[] {
  if (!isReaperSource(source)) throw new Error('REAPER_UNAPPROVED_SOURCE');
  return catalogs[source];
}

function bindingLimitation(capability: Capability): string {
  const limitation = REAPER_NATIVE_SEMANTICS[capability.bindingAction as keyof typeof REAPER_NATIVE_SEMANTICS];
  if (!capability.bindingAction || !limitation) throw new Error('REAPER_MAPPING_DISCLOSURE_MISSING');
  return limitation;
}

/** Host-only factory for the implemented audio equivalents; the full source remains unchanged. */
export function createReaperBindingSetup(input: ReaperBindingContext): ReaperBindingSetup {
  const source = SourceProfileSchema.parse(input.source);
  const catalog = catalogForSource(source.sourceApp);
  const entries: BindingApplicability['entries'] = Object.keys(source.bindings).sort().map(sourceAction => {
    const capability = catalog.find(candidate => candidate.bindingAction === sourceAction);
    if (!capability || !capability.values.includes(source.bindings[sourceAction]!))
      throw new Error('REAPER_UNSUPPORTED_SOURCE_BINDING');
    return { sourceAction, status: 'mapped', relation: 'equivalent', capabilityId: capability.id,
      limitation: bindingLimitation(capability), evidenceRefs: [REAPER_BINDING_EVIDENCE] };
  });
  const bindingApplicability: BindingApplicability = {
    version: 1, scenarioId: input.scenarioId,
    source: { profileId: source.profileId, revision: source.revision, sourceApp: source.sourceApp },
    target: { ...REAPER_TARGET }, entries,
  };
  const evidenceRefs = [REAPER_BINDING_EVIDENCE];
  resolveBindingRequirements({ scenarioId: input.scenarioId, source, target: REAPER_TARGET,
    catalog: [...catalog], evidenceRefs, bindingApplicability });
  return { catalog, bindingApplicability, evidenceRefs };
}

export function assertReaperRequest(value: PlannerRequest): PlannerRequest {
  const request = validateRequest(value);
  if (request.target.appId !== REAPER_TARGET.appId || request.target.adapterVersion !== REAPER_TARGET.adapterVersion)
    throw new Error('REAPER_WRONG_ADAPTER');
  const expected = catalogForSource(request.source.sourceApp);
  if (request.catalog.length !== expected.length || expected.some(capability => {
    const actual = request.catalog.find(candidate => candidate.id === capability.id);
    return !actual || actual.kind !== capability.kind || actual.bindingAction !== capability.bindingAction ||
      actual.preferenceKey !== capability.preferenceKey || actual.values.length !== capability.values.length ||
      capability.values.some((item, index) => actual.values[index] !== item);
  })) throw new Error('REAPER_UNTRUSTED_CATALOG');
  if (!request.bindingApplicability) throw new Error('REAPER_BINDING_POLICY_REQUIRED');
  // Shared validation preserves full source values, scope, trusted refs and disclosed
  // nonmapped actions. Pin each mapped destination's actual native semantics here,
  // including when the host supplies a differently named equivalent source action.
  for (const entry of request.bindingApplicability.entries) {
    if (entry.status !== 'mapped') continue;
    const capability = expected.find(candidate => candidate.id === entry.capabilityId);
    if (!capability?.bindingAction || entry.relation !== 'equivalent' ||
        entry.limitation !== bindingLimitation(capability) || entry.evidenceRefs.length !== 1 ||
        entry.evidenceRefs[0] !== REAPER_BINDING_EVIDENCE) throw new Error('REAPER_UNTRUSTED_BINDING_POLICY');
  }
  resolveBindingRequirements(request);
  return request;
}

/** Authored preparation only. planner service owns live planning and all live chat responses. */
export function resolveReaperRecipe(value: PlannerRequest): { operations: Operation[]; evidenceRefs: string[]; limitations: string[] } {
  const request = assertReaperRequest(value);
  if (request.kind !== 'translate') throw new Error('REAPER_PREPARED_TRANSLATE_ONLY');
  const requirements = resolveBindingRequirements(request);
  const bindings = new Map(requirements.requiredOperations.map(operation => [operation.capabilityId, operation.value]));
  const preferences = new Map(request.source.preferences.map(preference => [preference.key, preference.value]));
  request.explicit.forEach(preference => preferences.set(preference.key, preference.value));
  const defaults: Record<string, string> = { 'panel-side': 'right', 'work-area': 'normal', 'tool-density': 'full' };
  for (const preference of [
    ...request.source.preferences.filter(item => item.origin === 'explicit'), ...request.explicit,
  ]) {
    const capability = request.catalog.find(candidate => candidate.preferenceKey === preference.key);
    if (!capability || !capability.values.includes(preferences.get(preference.key)!))
      throw new Error('REAPER_UNSUPPORTED_EXPLICIT_PREFERENCE');
  }
  const operations = request.catalog.map(capability => {
    const desired = capability.bindingAction ? bindings.get(capability.id)
      : preferences.get(capability.preferenceKey!);
    if (capability.bindingAction && desired === undefined) throw new Error('REAPER_UNACCOUNTED_BINDING');
    const applied = desired ?? defaults[capability.preferenceKey!];
    if (!capability.values.includes(applied)) throw new Error('REAPER_RECIPE_UNSUPPORTED_VALUE');
    return { capabilityId: capability.id, value: applied };
  });
  return { operations, evidenceRefs: [...request.evidenceRefs], limitations: requirements.limitations };
}

/** Descriptions are deliberately bounded to the actual REAPER destination behavior. */
export const REAPER_NATIVE_SEMANTICS = Object.freeze({
  'panel-side': 'Move REAPER track control panels to the left or right of the arrange view; retain the native mixer.',
  'work-area': 'Enlarge timeline detail through track height and a tighter horizontal time view.',
  'tool-density': 'Use the installed Default 7 theme track and mixer layouts A or B; native menus retain other functions.',
  select: 'Choose native item selection and movement behavior.',
  'razor-tool': 'Choose a click-to-split audio-item tool; pressing C alone does not split an item.',
  'blade-tool': 'Choose a click-to-split audio-item tool; pressing B alone does not split an item.',
  pan: 'Choose hand scrolling over empty track space; this does not pan over every control or change audio stereo pan.',
  'play-pause': 'Toggle REAPER audio transport playback and pause.',
  'preview-toggle': 'Toggle REAPER audio playback and pause; no After Effects rendered-video preview is claimed.',
  'mark-in': 'Set the REAPER time-selection start at the edit cursor, retaining a later end or using the project end; an in point without a later out point is refused. This is not a source-clip conversion.',
});
