import type { Command, RuntimeScenario, RuntimeState } from '../../../contracts/bridge.js';
import { ChatIntentSchema, ROUTES, type TargetApp } from '../../../contracts/index.js';
import { matchingDisclosure, type WorkflowDisclosure } from './disclosures.js';

function consistentRow(row: RuntimeScenario): boolean {
  return row.profileId === row.source.profileId && row.personaId === row.source.personaId &&
    row.sourceApp === row.source.sourceApp && row.targetApp === row.target.appId &&
    ROUTES[row.sourceApp].includes(row.targetApp);
}
function sameIdentity(a: RuntimeScenario, b: RuntimeScenario): boolean {
  return a.scenarioId === b.scenarioId && a.profileId === b.profileId && a.source.revision === b.source.revision &&
    a.sourceApp === b.sourceApp && a.personaId === b.personaId && a.targetApp === b.targetApp &&
    a.target.adapterVersion === b.target.adapterVersion;
}

/** Display only the host's unambiguous rows. Availability never implies native QA passed. */
export function catalogCases(state?: RuntimeState | null): readonly RuntimeScenario[] {
  const catalog = state?.catalog;
  if (!catalog) return [];
  return catalog.cases.filter(row => {
    if (!consistentRow(row) || catalog.cases.filter(item => item.scenarioId === row.scenarioId).length !== 1) return false;
    const sources = catalog.profiles.filter(source => source.profileId === row.profileId);
    return sources.length === 1 && sources[0]!.revision === row.source.revision &&
      sources[0]!.sourceApp === row.sourceApp && sources[0]!.personaId === row.personaId;
  });
}

/** A profile/target choice must identify exactly one host scenario; never construct its ID. */
export function caseForChoice(state: RuntimeState | null | undefined, profileId: string, targetApp: TargetApp): RuntimeScenario | null {
  const rows = catalogCases(state).filter(row => row.profileId === profileId && row.targetApp === targetApp);
  return rows.length === 1 ? rows[0]! : null;
}

/** Active source/adapter identity comes from both host selection and the coordinator snapshot. */
export function activeCase(state?: RuntimeState | null): RuntimeScenario | null {
  const selection = state?.selection;
  const snapshot = state?.snapshot;
  if (!state || state.fixtureEnabled || !selection || !snapshot?.runId || !snapshot.target ||
    ['idle', 'resetting', 'error'].includes(snapshot.phase) || selection.scenarioId !== snapshot.scenarioId ||
    selection.target.appId !== snapshot.target.appId || selection.target.adapterVersion !== snapshot.target.adapterVersion) return null;
  const rows = catalogCases(state).filter(row => row.scenarioId === selection.scenarioId &&
    row.profileId === selection.profileId && row.source.revision === selection.profileRevision && row.sourceApp === selection.sourceApp &&
    row.targetApp === selection.target.appId && row.target.adapterVersion === selection.target.adapterVersion);
  return rows.length === 1 ? rows[0]! : null;
}

/** Return an ID-only command after checking current host availability, not a cached row's flags. */
export function selectionCommand(state: RuntimeState | null | undefined, row: RuntimeScenario | null | undefined,
  pending: Command['type'] | null = null): Extract<Command, { type: 'select-scenario' }> | null {
  if (!state || !row || pending || state.fixtureEnabled || state.qa.enabled || state.qa.running ||
    !state.nativeAdapterAvailable || state.snapshot.phase !== 'idle' || state.snapshot.busy) return null;
  const current = catalogCases(state).find(candidate => sameIdentity(candidate, row));
  if (!current || !current.selectable || current.reasonCode !== null ||
    !current.initialModes.includes(state.nativePrepared ? 'prepared' : 'live')) return null;
  return { type: 'select-scenario', scenarioId: current.scenarioId };
}

/** Preserve host-authored wording; callers send only the bounded intent, never its instruction. */
export function chatChoices(state?: RuntimeState | null): RuntimeScenario['chatIntents'] {
  if (!state || !state.chatAvailable || state.qa.enabled || state.qa.running ||
    state.snapshot.evidenceKind !== 'native' || !['ready', 'chat'].includes(state.snapshot.phase)) return [];
  const row = activeCase(state);
  if (!row || new Set(row.chatIntents.map(item => item.intent)).size !== row.chatIntents.length ||
    row.chatIntents.some(item => !ChatIntentSchema.safeParse(item.intent).success || !item.label.trim() || !item.instruction.trim())) return [];
  return row.chatIntents;
}

/** Project trusted host metadata without creating policy, explanations, evidence or image URLs. */
export function disclosureForCase(row?: RuntimeScenario | null): WorkflowDisclosure | null {
  if (!row || !consistentRow(row)) return null;
  const disclosure: WorkflowDisclosure = {
    scope: { scenarioId: row.scenarioId, source: { profileId: row.source.profileId, revision: row.source.revision, sourceApp: row.source.sourceApp }, target: structuredClone(row.target) },
    ...(row.bindingApplicability ? { bindingApplicability: structuredClone(row.bindingApplicability) } : {}),
    catalog: structuredClone([...row.catalog]), trustedEvidenceRefs: [...row.trustedEvidenceRefs], tools: [],
  };
  return matchingDisclosure({ scenarioId: row.scenarioId, profile: row.source, target: row.target }, disclosure) ? disclosure : null;
}
