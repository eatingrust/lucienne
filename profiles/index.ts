import profileData from './personas.json' with { type: 'json' };
import { SourceProfileSchema, ROUTES, assertRoute, resolveBindingRequirements } from '../contracts/index.js';
import type { SourceApp, SourceProfile, TargetApp, Capability, BindingRequirementContext, BindingRequirements } from '../contracts/index.js';

/** Shared-contract source profiles; no source app must be installed to load these simulated personas. */
export function loadProfiles(): SourceProfile[] {
  const records: unknown = profileData;
  if (!Array.isArray(records)) throw new Error('Invalid persona catalog.');
  const profiles = records.map(value => SourceProfileSchema.parse(value));
  if (new Set(profiles.map(p => p.profileId)).size !== profiles.length) throw new Error('Duplicate profile ID.');
  for (const source of Object.keys(ROUTES) as SourceApp[]) {
    if (profiles.filter(p => p.sourceApp === source).length !== 3) throw new Error('Each approved source requires three personas.');
  }
  return profiles;
}
export function getProfile(profileId: string): SourceProfile {
  const profile = loadProfiles().find(p => p.profileId === profileId);
  if (!profile) throw new Error('Unknown source persona.');
  return profile;
}
export function plannedCases() {
  return loadProfiles().flatMap(source => ROUTES[source.sourceApp].map(target => ({
    scenarioId: `${source.profileId}-to-${target}`, profileId: source.profileId,
    sourceApp: source.sourceApp, targetApp: target, nativeStatus: 'not-run' as const,
  })));
}
/** Supplied only by a trusted host using reviewed policy and evidence, never model/renderer input. */
export type TrustedPreparationContext = Pick<BindingRequirementContext,
  'scenarioId' | 'target' | 'evidenceRefs' | 'bindingApplicability'>;
export interface PreparationAssessment extends BindingRequirements { gaps: string[] }

function explicitPreferenceGaps(source: SourceProfile, catalog: readonly Capability[]): string[] {
  const gaps: string[] = [];
  for (const pref of source.preferences.filter(p => p.origin === 'explicit')) {
    if (!catalog.some(c => c.preferenceKey === pref.key && c.values.includes(pref.value))) gaps.push(`Unsupported explicit preference: ${pref.key}=${pref.value}`);
  }
  return gaps;
}
function legacyPreparationGaps(source: SourceProfile, target: TargetApp, catalog: readonly Capability[]): string[] {
  assertRoute(source.sourceApp, target);
  const gaps: string[] = [];
  for (const [action, value] of Object.entries(source.bindings)) {
    if (!catalog.some(c => c.kind === 'binding' && c.bindingAction === action && c.values.includes(value))) gaps.push(`Unsupported source binding: ${action}=${value}`);
  }
  return [...gaps, ...explicitPreferenceGaps(source, catalog)];
}

/** host resolves applicability; preserve its source-valued operations and disclosed limitations. */
export function assessPreparation(source: SourceProfile, target: TargetApp, catalog: readonly Capability[],
  context: TrustedPreparationContext): PreparationAssessment {
  if (!context || typeof context !== 'object' || Array.isArray(context)
      || Object.keys(context).some(key => !['scenarioId', 'target', 'evidenceRefs', 'bindingApplicability'].includes(key))) {
    throw new Error('INVALID_PREPARATION_CONTEXT');
  }
  if (context.target?.appId !== target) throw new Error('PREPARATION_TARGET_CONTEXT_MISMATCH');
  let bindings: BindingRequirements;
  try {
    // Construct explicitly: context cannot substitute another source or capability catalog.
    bindings = resolveBindingRequirements({ scenarioId: context.scenarioId, source, target: context.target,
      catalog: [...catalog], evidenceRefs: context.evidenceRefs, bindingApplicability: context.bindingApplicability });
  } catch (error) {
    // The legacy gap API reports unavailable direct bindings instead of throwing for them.
    if (context.bindingApplicability === undefined && error instanceof Error && error.message === 'SOURCE_BINDING_NOT_PRESERVED') {
      return { gaps: legacyPreparationGaps(source, target, catalog), limitations: [], requiredOperations: [] };
    }
    throw error;
  }
  return { gaps: explicitPreferenceGaps(source, catalog), limitations: [...bindings.limitations],
    requiredOperations: bindings.requiredOperations.map(operation => ({ ...operation })) };
}

/** Absent policy retains strict direct-binding gaps; trusted callers may opt into host policy. */
export function preparationGaps(source: SourceProfile, target: TargetApp, catalog: readonly Capability[],
  context?: TrustedPreparationContext): string[] {
  return context?.bindingApplicability === undefined ? legacyPreparationGaps(source, target, catalog)
    : assessPreparation(source, target, catalog, context).gaps;
}
