import {
  SourceProfileSchema, validatePatch, validateRequest,
  type ChatIntent, type PlannerRequest, type PlannerResult, type SourceProfile,
} from '../../contracts/index.js';
import { createReaperBindingSetup, REAPER_TARGET, resolveReaperRecipe } from './catalog.js';

export const REAPER_CHAT_PROMPTS: ReadonlyArray<{ intent: ChatIntent; label: string; instruction: string }> = Object.freeze(([
  { intent: 'move-key-panels', label: 'Move my track controls', instruction: 'Move the native track controls to the other side of the timeline. Preserve my explicit preferences and source shortcuts.' },
  { intent: 'enlarge-work-area', label: 'Enlarge timeline detail', instruction: 'Make the audio timeline easier to work in by enlarging track height and timeline detail. Preserve my explicit preferences and source shortcuts.' },
  { intent: 'simplify-tools', label: 'Simplify track and mixer controls', instruction: 'Simplify the visible native track and mixer control layouts while keeping the native menus and my source shortcuts available.' },
] satisfies Array<{ intent: ChatIntent; label: string; instruction: string }>).map(prompt => Object.freeze(prompt)));

/** Use an actual profile service profile. Its simulated persona provenance remains intact. */
export function createReaperExample(source: SourceProfile, identity: { runId?: string; requestId?: string } = {}): {
  request: PlannerRequest; result: PlannerResult;
} {
  const profile = SourceProfileSchema.parse(source);
  const scenarioId = `${profile.profileId}-to-reaper`;
  const bindingSetup = createReaperBindingSetup({ scenarioId, source: profile });
  const request = validateRequest({
    version: 1, runId: identity.runId ?? 'reaper-prepared-example-run',
    requestId: identity.requestId ?? 'reaper-prepared-example-request',
    scenarioId, kind: 'translate', target: REAPER_TARGET,
    source: profile, explicit: [], instruction: 'Apply the authored source-familiar audio timeline recipe.',
    catalog: structuredClone([...bindingSetup.catalog]), bindingApplicability: bindingSetup.bindingApplicability,
    currentOperations: [], evidenceRefs: [...new Set([...profile.evidenceRefs, ...bindingSetup.evidenceRefs])],
  });
  return { request, result: createPreparedReaperResult(request) };
}

/** An explicit prepared result for integration. Never label this result as live. */
export function createPreparedReaperResult(request: PlannerRequest): PlannerResult {
  const recipe = resolveReaperRecipe(request);
  const contextNotices = [
    'Authored preparation; source demonstration personas remain simulated and native verification is a separate step.',
    'Native audio selection, split, trim and playback semantics; no media conversion or source-app effects are reproduced.',
    'Panel-side moves track controls; work-area enlarges timeline detail; tool density uses the installed native theme layouts.',
  ];
  const patch = validatePatch({
    version: 1, runId: request.runId, requestId: request.requestId, scenarioId: request.scenarioId,
    target: REAPER_TARGET, ...recipe,
    summary: 'Prepared REAPER timeline, track/mixer controls and source-binding recipe.',
    // The resolver bounds mandatory notices to twelve. Fill spare slots with
    // generic context; never truncate a host-required source limitation.
    limitations: [...recipe.limitations, ...contextNotices.slice(0, 12 - recipe.limitations.length)],
  }, request);
  return { patch, provenance: { mode: 'prepared', provider: 'reaper-authored-recipe', evidenceRefs: [...recipe.evidenceRefs] } };
}
