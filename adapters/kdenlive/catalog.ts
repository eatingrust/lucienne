import { BindingApplicabilitySchema, resolveBindingRequirements, validateRequest, type BindingApplicability, type BindingRequirements, type Capability, type Operation, type PlannerRequest, type SourceApp, type SourceProfile } from '../../contracts/index.js';

import { KDENLIVE_MAPPING_EVIDENCE } from './mappings.js';

export const KDENLIVE_TARGET = Object.freeze({ appId: 'kdenlive' as const, adapterVersion: 'kdenlive-24.08.1-v1' });
/** Verified native IDs from the installed 24.08.1 shortcut scheme. An action ID is
 * evidence of a native action, not evidence of a translated shortcut having run. */
export const NATIVE_ACTIONS = Object.freeze({
  select: { id: 'select_tool', values: ['V'], meaning: 'Select timeline clips using the Selection Tool.' },
  'razor-tool': { id: 'razor_tool', values: ['C'], meaning: 'Cut a clip at the click location using the Razor Tool.' },
  'blade-tool': { id: 'razor_tool', values: ['B'], meaning: 'Cut a clip at the click location using the Razor Tool.' },
  'play-pause': { id: 'monitor_play', values: ['Space'], meaning: 'Toggle playback in the active monitor.' },
  'preview-toggle': { id: 'monitor_play', values: ['Space'], meaning: 'Toggle project/clip monitor preview playback.' },
  'mark-in': { id: 'mark_in', values: ['I'], meaning: 'Set the active monitor zone in point.' },
});
for (const action of Object.values(NATIVE_ACTIONS)) {Object.freeze(action.values);Object.freeze(action);}
// Catalog includes implemented native actions only. Applicability can disclose a
// genuinely absent brush; unimplemented title controls remain explicit blockers.
const SOURCE_ACTIONS: Record<SourceApp, readonly string[]> = {
  photoshop: ['brush', 'select-rectangle', 'transform'],
  illustrator: ['select', 'pan', 'zoom'],
  gimp: ['brush', 'select-rectangle', 'transform'],
  premiere: ['select', 'razor-tool', 'play-pause'],
  'after-effects': ['select', 'pan', 'preview-toggle'],
  resolve: ['play-pause', 'blade-tool', 'mark-in'],
};
const layout: Capability[] = [
  { id: 'kdenlive.layout.panel-side', kind: 'layout', preferenceKey: 'panel-side', values: ['left', 'right'] },
  { id: 'kdenlive.timeline.work-area', kind: 'timeline', preferenceKey: 'work-area', values: ['normal', 'large'] },
  { id: 'kdenlive.tool-layout.density', kind: 'tool-layout', preferenceKey: 'tool-density', values: ['full', 'simple'] },
];
export function kdenliveCatalog(sourceApp: SourceApp): Capability[] {
  if (!SOURCE_ACTIONS[sourceApp]) throw new Error('KDENLIVE_UNKNOWN_SOURCE');
  return structuredClone([...layout, ...SOURCE_ACTIONS[sourceApp].flatMap(action => {
    const native = NATIVE_ACTIONS[action as keyof typeof NATIVE_ACTIONS];
    return native ? [{ id: `kdenlive.binding.${action}`, kind: 'binding' as const, bindingAction: action, values: [...native.values] }] : [];
  })]);
}
export type KdenliveBindingPreparation =
  | { status: 'ready'; bindingApplicability: BindingApplicability; evidenceRefs: string[]; requirements: BindingRequirements }
  | { status: 'blocked'; unresolvedActions: string[]; limitations: string[]; evidenceRefs: string[] };

/** Host-authored per-case policy. Never accept model/renderer exemptions or turn
 * an unimplemented candidate into an unavailable/out-of-main-controls waiver. */
export function prepareKdenliveBindings(source: SourceProfile, scenarioId: string): KdenliveBindingPreparation {
  const entries: BindingApplicability['entries'] = [], unresolvedActions: string[] = [], limitations: string[] = [], evidenceRefs: string[] = [];
  const catalog = kdenliveCatalog(source.sourceApp);
  for (const action of Object.keys(source.bindings).sort()) {
    const finding = KDENLIVE_MAPPING_EVIDENCE.find(item => item.action === action);
    if (!finding || finding.disposition === 'unproven') {
      unresolvedActions.push(action);
      if (finding) evidenceRefs.push(finding.evidenceRef);
      continue;
    }
    evidenceRefs.push(finding.evidenceRef);
    if (finding.disposition === 'unavailable') {
      entries.push({sourceAction:action,status:'unavailable',reason:'target-feature-absent',limitation:finding.limitation,evidenceRefs:[finding.evidenceRef]});
      limitations.push(`${action}: ${finding.limitation}`);
    } else {
      const capability = catalog.find(c => c.bindingAction === action);
      if (!capability) {unresolvedActions.push(action);continue;}
      entries.push({sourceAction:action,status:'mapped',capabilityId:capability.id,
        relation:action==='preview-toggle' ? 'equivalent' : 'direct',evidenceRefs:[finding.evidenceRef]});
    }
  }
  const refs = [...new Set(evidenceRefs)];
  if (unresolvedActions.length) return {status:'blocked',unresolvedActions,limitations,evidenceRefs:refs};
  const bindingApplicability = BindingApplicabilitySchema.parse({version:1,scenarioId,
    source:{profileId:source.profileId,revision:source.revision,sourceApp:source.sourceApp},target:KDENLIVE_TARGET,entries});
  const requirements = resolveBindingRequirements({scenarioId,source,target:KDENLIVE_TARGET,catalog,
    evidenceRefs:[...new Set([...source.evidenceRefs,...refs])],bindingApplicability});
  return {status:'ready',bindingApplicability,evidenceRefs:refs,requirements};
}
export function kdenliveGaps(source: SourceProfile, scenarioId = `${source.profileId}-to-kdenlive`): string[] {
  try {
    const preparation = prepareKdenliveBindings(source,scenarioId);
    return preparation.status==='blocked' ? preparation.unresolvedActions.map(action=>`Unproven source action ${action}=${source.bindings[action]}`) : [];
  } catch(error) {
    return [error instanceof Error ? error.message : 'KDENLIVE_BINDING_PREPARATION_FAILED'];
  }
}
function canonicalPolicy(policy: BindingApplicability): string {
  const parsed = BindingApplicabilitySchema.parse(policy);
  return JSON.stringify({...parsed,entries:parsed.entries.map(entry=>({...entry,evidenceRefs:[...entry.evidenceRefs].sort()})).sort((a,b)=>a.sourceAction.localeCompare(b.sourceAction))});
}
export function assertKdenliveRequest(input: PlannerRequest, sourceApp: SourceApp): PlannerRequest {
  const request = validateRequest(input);
  if (request.target.appId !== KDENLIVE_TARGET.appId || request.target.adapterVersion !== KDENLIVE_TARGET.adapterVersion || request.source.sourceApp !== sourceApp)
    throw new Error('KDENLIVE_WRONG_ADAPTER');
  const expected = kdenliveCatalog(sourceApp);
  if (request.catalog.length !== expected.length || expected.some(c => {
    const actual = request.catalog.find(a => a.id === c.id);
    return !actual || actual.kind !== c.kind || actual.bindingAction !== c.bindingAction || actual.preferenceKey !== c.preferenceKey ||
      actual.values.length !== c.values.length || actual.values.some((v, i) => v !== c.values[i]);
  })) throw new Error('KDENLIVE_UNTRUSTED_CATALOG');
  if (request.bindingApplicability) {
    const authored = prepareKdenliveBindings(request.source,request.scenarioId);
    if (authored.status==='blocked') throw new Error('KDENLIVE_UNPROVEN_BINDING');
    if (canonicalPolicy(request.bindingApplicability)!==canonicalPolicy(authored.bindingApplicability)) throw new Error('KDENLIVE_UNTRUSTED_BINDING_POLICY');
  }
  // The shared resolver remains the only operation/limitation validator. No policy
  // means the shared strict legacy behavior; a policy must be the author's exact one.
  resolveBindingRequirements(request);
  return request;
}
/** Authored prepared translation recipe. Never used as live planner/chat output. */
export function resolveKdenliveRecipe(input: PlannerRequest): { operations: Operation[]; evidenceRefs: string[]; limitations: string[] } {
  const request = assertKdenliveRequest(input, input.source.sourceApp);
  if (request.kind !== 'translate') throw new Error('KDENLIVE_PREPARED_TRANSLATE_ONLY');
  const bindings = resolveBindingRequirements(request);
  const required = new Map(bindings.requiredOperations.map(operation=>[operation.capabilityId,operation.value]));
  const preferences = new Map(request.source.preferences.map(p => [p.key, p.value]));
  request.explicit.forEach(p => preferences.set(p.key, p.value));
  const defaults: Record<string, string> = { 'panel-side': 'right', 'work-area': 'normal', 'tool-density': 'full' };
  return { operations: request.catalog.map(c => {
    const value = c.bindingAction ? required.get(c.id) : preferences.get(c.preferenceKey!) ?? defaults[c.preferenceKey!];
    if (!value || !c.values.includes(value)) throw new Error('KDENLIVE_RECIPE_UNSUPPORTED_VALUE');
    return { capabilityId: c.id, value };
  }), evidenceRefs: [...request.evidenceRefs], limitations: [...bindings.limitations] };
}
export function nativeBindings(operations: readonly Operation[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const op of operations.filter(o => o.capabilityId.startsWith('kdenlive.binding.'))) {
    const action = NATIVE_ACTIONS[op.capabilityId.slice('kdenlive.binding.'.length) as keyof typeof NATIVE_ACTIONS];
    if (!action || !(action.values as readonly string[]).includes(op.value)) throw new Error('KDENLIVE_UNSUPPORTED_BINDING');
    if (result[action.id] && result[action.id] !== op.value) throw new Error('KDENLIVE_BINDING_COLLISION');
    result[action.id] = op.value;
  }
  if (new Set(Object.values(result)).size !== Object.values(result).length) throw new Error('KDENLIVE_BINDING_COLLISION');
  return result;
}
