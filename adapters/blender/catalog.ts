import data from './catalog.json' with { type: 'json' };
import { BLENDER_BINDING_LIMITATIONS } from './binding-limitations.js';
import {
  CapabilitySchema, SourceProfileSchema, resolveBindingRequirements, validatePatch, validateRequest,
  type BindingApplicability, type Capability, type NativePatch, type Operation, type PlannerRequest, type SourceProfile,
} from '../../contracts/index.js';

export const BLENDER_TARGET = Object.freeze({ appId: 'blender' as const, adapterVersion: 'blender-5.2.3-v1' });
/** Complete native wire catalog. Scoped planner catalogs are derived below, never supplied by a model. */
export const BLENDER_CATALOG: readonly Capability[] = Object.freeze(data.map(value => {
  const capability = CapabilitySchema.parse(value);
  Object.freeze(capability.values);
  return Object.freeze(capability);
}));
export const BLENDER_BINDING_EVIDENCE = 'blender:binding-recipes:5.2.3-v1';
export interface BlenderBindingContext { scenarioId: string; source: SourceProfile }
export interface BlenderBindingSetup {
  catalog: readonly Capability[];
  bindingApplicability: BindingApplicability;
  evidenceRefs: string[];
}
const defaults: Readonly<Record<string, string>> = Object.freeze({
  'panel-side': 'right', 'work-area': 'normal', 'tool-density': 'full',
});

function supportedBindings(source: SourceProfile): void {
  for (const [action, binding] of Object.entries(source.bindings)) {
    const capability = BLENDER_CATALOG.find(entry => entry.bindingAction === action);
    if (!capability || binding === 'disabled' || !capability.values.includes(binding))
      throw new Error('BLENDER_UNSUPPORTED_SOURCE_BINDING');
  }
  const bindings = Object.values(source.bindings);
  if (new Set(bindings).size !== bindings.length) throw new Error('BLENDER_CONFLICTING_SOURCE_BINDINGS');
}
function catalogMatches(actual: readonly Capability[], expected: readonly Capability[]): boolean {
  return actual.length === expected.length && expected.every(capability => {
    const found = actual.find(entry => entry.id === capability.id);
    return !!found && found.kind === capability.kind && found.bindingAction === capability.bindingAction &&
      found.preferenceKey === capability.preferenceKey && found.values.length === capability.values.length &&
      capability.values.every((value, index) => found.values[index] === value);
  });
}

/** Host-only factory for existing implemented equivalents. No exemption, alias or source mutation is inferred. */
export function createBlenderBindingSetup(input: BlenderBindingContext): BlenderBindingSetup {
  const source = SourceProfileSchema.parse(input.source);
  supportedBindings(source);
  const catalog = Object.freeze(BLENDER_CATALOG.filter(capability => !capability.bindingAction ||
    Object.hasOwn(source.bindings, capability.bindingAction)));
  const entries: BindingApplicability['entries'] = Object.keys(source.bindings).sort().map(sourceAction => {
    const limitation = BLENDER_BINDING_LIMITATIONS[sourceAction];
    if (!limitation) throw new Error('BLENDER_MAPPING_DISCLOSURE_MISSING');
    return { sourceAction, status: 'mapped', relation: 'equivalent', capabilityId: `blender.binding.${sourceAction}`,
      limitation, evidenceRefs: [BLENDER_BINDING_EVIDENCE] };
  });
  const bindingApplicability: BindingApplicability = {
    version: 1, scenarioId: input.scenarioId,
    source: { profileId: source.profileId, revision: source.revision, sourceApp: source.sourceApp },
    target: { ...BLENDER_TARGET }, entries,
  };
  // Source provenance remains on the full source profile. This ref authorizes only the host's recipe mapping.
  const evidenceRefs = [BLENDER_BINDING_EVIDENCE];
  resolveBindingRequirements({ scenarioId: input.scenarioId, source, target: BLENDER_TARGET,
    catalog: [...catalog], evidenceRefs, bindingApplicability });
  return { catalog, bindingApplicability, evidenceRefs };
}

export function assertBlenderRequest(value: PlannerRequest): PlannerRequest {
  const request = validateRequest(value);
  if (request.target.appId !== BLENDER_TARGET.appId || request.target.adapterVersion !== BLENDER_TARGET.adapterVersion)
    throw new Error('BLENDER_WRONG_ADAPTER');
  supportedBindings(request.source);
  if (request.bindingApplicability) {
    const expected = createBlenderBindingSetup(request);
    if (!catalogMatches(request.catalog, expected.catalog)) throw new Error('BLENDER_UNTRUSTED_CATALOG');
    // Shared validation binds identity, source values and evidence. The adapter additionally pins its actual equivalences.
    const entries = new Map(request.bindingApplicability.entries.map(entry => [entry.sourceAction, entry]));
    for (const trusted of expected.bindingApplicability.entries) {
      const actual = entries.get(trusted.sourceAction);
      if (actual?.status !== 'mapped' || trusted.status !== 'mapped' || actual.relation !== trusted.relation ||
          actual.capabilityId !== trusted.capabilityId || actual.limitation !== trusted.limitation || actual.evidenceRefs.length !== 1 ||
          actual.evidenceRefs[0] !== BLENDER_BINDING_EVIDENCE) throw new Error('BLENDER_UNTRUSTED_BINDING_POLICY');
    }
  } else if (!catalogMatches(request.catalog, BLENDER_CATALOG)) throw new Error('BLENDER_UNTRUSTED_CATALOG');
  const explicit = [...request.source.preferences.filter(preference => preference.origin === 'explicit'), ...request.explicit];
  for (const preference of explicit) {
    const capability = request.catalog.find(entry => entry.preferenceKey === preference.key);
    if (!capability || !capability.values.includes(preference.value)) throw new Error('BLENDER_UNSUPPORTED_EXPLICIT_PREFERENCE');
  }
  return request;
}

/** Both legacy and scoped paths preserve source controls; neither admits model-invented capabilities. */
export function validateBlenderPatch(value: unknown, input: PlannerRequest): NativePatch {
  const request = assertBlenderRequest(input);
  const patch = validatePatch(value, request);
  const requirements = resolveBindingRequirements(request);
  const required = new Map(requirements.requiredOperations.map(operation => [operation.capabilityId, operation.value]));
  for (const capability of request.catalog) {
    if (!capability.bindingAction) continue;
    if (patch.operations.find(operation => operation.capabilityId === capability.id)?.value !== (required.get(capability.id) ?? 'disabled'))
      throw new Error('BLENDER_UNREQUESTED_BINDING');
  }
  return patch;
}

/** Authored initial recipe, explicitly prepared. Live planning/chat remains planner service's job. */
export function resolveBlenderRecipe(value: PlannerRequest): { operations: Operation[]; evidenceRefs: string[]; limitations: string[] } {
  const request = assertBlenderRequest(value);
  if (request.kind !== 'translate') throw new Error('BLENDER_RECIPE_UNAVAILABLE');
  const preferences = new Map(request.source.preferences.map(preference => [preference.key, preference.value]));
  request.explicit.forEach(preference => preferences.set(preference.key, preference.value));
  const requirements = resolveBindingRequirements(request);
  const required = new Map(requirements.requiredOperations.map(operation => [operation.capabilityId, operation.value]));
  const operations = request.catalog.map(capability => {
    const value = capability.bindingAction ? required.get(capability.id) ?? 'disabled'
      : preferences.get(capability.preferenceKey!) ?? defaults[capability.preferenceKey!];
    if (!capability.values.includes(value)) throw new Error('BLENDER_RECIPE_UNSUPPORTED_VALUE');
    return { capabilityId: capability.id, value };
  });
  return { operations, evidenceRefs: [...request.evidenceRefs],
    limitations: requirements.limitations };
}

/** Internal wire expansion: the planner never controls inactive-family defaults. */
export function expandBlenderOperations(patch: NativePatch, request: PlannerRequest): Operation[] {
  const validated = validateBlenderPatch(patch, request);
  const managed = new Map(validated.operations.map(operation => [operation.capabilityId, operation.value]));
  return BLENDER_CATALOG.map(capability => {
    const value = managed.get(capability.id);
    if (value === undefined && !capability.bindingAction) throw new Error('BLENDER_INCOMPLETE_LAYOUT');
    return { capabilityId: capability.id, value: value ?? 'disabled' };
  });
}

/** Validate the complete observed wire state before projecting actual managed values. */
export function projectBlenderReadback(operations: readonly Operation[], managedCatalog: readonly Capability[]): Operation[] {
  if (operations.length !== BLENDER_CATALOG.length) throw new Error('BLENDER_INCOMPLETE_NATIVE_READBACK');
  const managed = new Set(managedCatalog.map(capability => capability.id));
  const seen = new Set<string>();
  for (const operation of operations) {
    const capability = BLENDER_CATALOG.find(entry => entry.id === operation.capabilityId);
    if (!capability || seen.has(operation.capabilityId) || !capability.values.includes(operation.value))
      throw new Error('BLENDER_INVALID_NATIVE_READBACK');
    seen.add(operation.capabilityId);
    if (!managed.has(capability.id) && (!capability.bindingAction || operation.value !== 'disabled'))
      throw new Error('BLENDER_UNMANAGED_BINDING_ACTIVE');
  }
  return operations.filter(operation => managed.has(operation.capabilityId)).map(operation => ({ ...operation }));
}
