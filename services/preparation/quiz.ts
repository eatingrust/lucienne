import { QuizTurnSchema, QuizResultSchema, SourceProfileSchema } from '../../contracts/index.js';

type Turn = ReturnType<typeof QuizTurnSchema.parse>;
type Result = ReturnType<typeof QuizResultSchema.parse>;
type Profile = ReturnType<typeof SourceProfileSchema.parse>;
type Preference = Profile['preferences'][number];

export interface QuizInput {
  source: Profile;
  turns: Turn[];
  userEvidence: Array<{ turnId: string; evidenceRef: string }>;
  nextRevision: string;
  invocationEvidenceRef: string;
}
export interface QuizModelPort {
  provider: string;
  mode: Result['provenance']['mode'];
  next(input: QuizInput & { instruction: string }, signal: AbortSignal): Promise<unknown>;
}
const instruction = 'Ask a useful next question or complete the profile; no fixed question count. Return the shared QuizResult shape. Preserve source identity, bindings, source provenance and every explicit preference. New or changed preferences are inferred and must cite a supplied userEvidence reference plus invocationEvidenceRef. Never turn an inference into an explicit preference. A continue result has a question and no profile; a complete result has a full profile and no question. Use nextRevision only for the completed profile. Source provenance may be simulated even when this model call is live.';

function parseProfile(value: unknown): Profile {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string' || serialized.length > 64_000) throw Error();
    const profile = SourceProfileSchema.parse(value);
    if (Object.keys(profile.bindings).length > 64 || new Set(profile.preferences.map(p => p.key)).size !== profile.preferences.length) throw Error();
    return profile;
  } catch { throw new Error('INVALID_QUIZ_PROFILE'); }
}
function sameSet(a: string[], b: string[]): boolean { return new Set(a).size === a.length && new Set(b).size === b.length && a.length === b.length && a.every(v => b.includes(v)); }
function samePreference(a: Preference, b: Preference): boolean {
  return a.key === b.key && a.value === b.value && a.origin === b.origin && sameSet(a.evidenceRefs, b.evidenceRefs);
}
function sourceRefs(source: Profile): string[] {
  return [...new Set([...source.evidenceRefs, ...source.provenance.evidenceRefs, ...source.preferences.flatMap(p => p.evidenceRefs)])];
}
function parseTurns(value: Turn[]): Turn[] {
  try {
    if (!Array.isArray(value) || value.length > 48) throw Error();
    const turns = value.map(turn => QuizTurnSchema.parse(turn));
    if (turns.reduce((n, t) => n + t.text.length, 0) > 16_000 || new Set(turns.map(t => t.turnId)).size !== turns.length) throw Error();
    for (let i = 1; i < turns.length; i++) if (turns[i].role === turns[i - 1].role) throw Error();
    return turns;
  } catch { throw new Error('INVALID_QUIZ_TRANSCRIPT'); }
}
function checkUserEvidence(turns: Turn[], evidence: QuizInput['userEvidence']): Map<string, string> {
  if (!Array.isArray(evidence) || evidence.length > 24) throw new Error('INVALID_QUIZ_USER_EVIDENCE');
  const byTurn = new Map<string, string>();
  const seen = new Set<string>();
  for (const entry of evidence) {
    if (!entry || !turns.some(t => t.turnId === entry.turnId && t.role === 'user') || byTurn.has(entry.turnId) || seen.has(entry.evidenceRef)) throw new Error('INVALID_QUIZ_USER_EVIDENCE');
    byTurn.set(entry.turnId, entry.evidenceRef); seen.add(entry.evidenceRef);
  }
  if (turns.filter(t => t.role === 'user').some(t => !byTurn.has(t.turnId))) throw new Error('MISSING_QUIZ_USER_EVIDENCE');
  return byTurn;
}
function parseInvocation(provider: string, mode: Result['provenance']['mode'], refs: string[]): Result['provenance'] {
  try {
    return QuizResultSchema.parse({ version: 1, status: 'continue', question: 'Validation', provenance: { provider, mode, evidenceRefs: refs } }).provenance;
  } catch { throw new Error('INVALID_QUIZ_INVOCATION'); }
}
function abortError(): Error { const e = new Error('QUIZ_ABORTED'); e.name = 'AbortError'; return e; }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
/** Discard a cancelled response promptly. This does not prove remote inference stopped. */
async function invoke(model: QuizModelPort, input: QuizInput, signal: AbortSignal): Promise<unknown> {
  throwIfAborted(signal);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(abortError()); signal.addEventListener('abort', onAbort, { once: true }); });
  try {
    const pending = Promise.resolve().then(() => {
      throwIfAborted(signal);
      return model.next({ ...structuredClone(input), instruction }, signal);
    });
    const result = await Promise.race([pending, aborted]);
    throwIfAborted(signal);
    return result;
  } catch {
    if (signal.aborted) throw abortError();
    throw new Error('QUIZ_MODEL_FAILED');
  } finally { signal.removeEventListener('abort', onAbort); }
}

/** Preparation/setup only. Model output is a proposal; caller owns persistence and session identity. */
export async function nextQuizTurn(model: QuizModelPort, raw: QuizInput, signal: AbortSignal): Promise<Result> {
  throwIfAborted(signal);
  const source = parseProfile(raw.source);
  const turns = parseTurns(raw.turns);
  if (turns.at(-1)?.role === 'assistant') throw new Error('QUIZ_WAITING_FOR_USER');
  const userEvidence = structuredClone(raw.userEvidence);
  const byTurn = checkUserEvidence(turns, userEvidence);
  const invocation = parseInvocation(model.provider, model.mode, [raw.invocationEvidenceRef, ...byTurn.values()]);
  if (new Set(invocation.evidenceRefs).size !== invocation.evidenceRefs.length || sourceRefs(source).includes(raw.invocationEvidenceRef)) throw new Error('DUPLICATE_QUIZ_INVOCATION');
  const revisionCheck = parseProfile({ ...source, revision: raw.nextRevision });
  if (revisionCheck.revision === source.revision) throw new Error('QUIZ_REVISION_NOT_ADVANCED');
  const input: QuizInput = { source, turns, userEvidence, nextRevision: raw.nextRevision, invocationEvidenceRef: raw.invocationEvidenceRef };
  const untrusted = await invoke(model, input, signal);
  let result: Result;
  try {
    const serialized = JSON.stringify(untrusted);
    if (typeof serialized !== 'string' || serialized.length > 64_000) throw Error();
    result = QuizResultSchema.parse(untrusted);
  } catch { throw new Error('INVALID_QUIZ_RESULT'); }
  const allowedRefs = new Set([...sourceRefs(source), ...byTurn.values(), input.invocationEvidenceRef]);
  const knownRefs = (refs: string[]) => refs.every(ref => allowedRefs.has(ref)) && new Set(refs).size === refs.length;
  if (result.provenance.provider !== invocation.provider || result.provenance.mode !== invocation.mode || !result.provenance.evidenceRefs.includes(input.invocationEvidenceRef) || !knownRefs(result.provenance.evidenceRefs)) throw new Error('INVALID_QUIZ_PROVENANCE');
  if (result.status === 'continue') {
    if (!result.question?.trim() || result.profile) throw new Error('INVALID_QUIZ_CONTINUATION');
    return result;
  }
  if (!result.profile || result.question !== undefined) throw new Error('INVALID_QUIZ_COMPLETION');
  const profile = parseProfile(result.profile);
  for (const key of ['version', 'profileId', 'sourceApp', 'personaId', 'label'] as const) if (profile[key] !== source[key]) throw new Error('QUIZ_IDENTITY_CHANGED');
  if (profile.revision !== input.nextRevision) throw new Error('QUIZ_REVISION_CHANGED');
  if (profile.provenance.mode !== source.provenance.mode || profile.provenance.provider !== source.provenance.provider || !sameSet(profile.provenance.evidenceRefs, source.provenance.evidenceRefs)) throw new Error('QUIZ_SOURCE_PROVENANCE_CHANGED');
  if (Object.keys(profile.bindings).length !== Object.keys(source.bindings).length || Object.entries(source.bindings).some(([key, value]) => profile.bindings[key] !== value)) throw new Error('QUIZ_SOURCE_BINDING_CHANGED');
  if (!knownRefs(profile.evidenceRefs) || source.evidenceRefs.some(ref => !profile.evidenceRefs.includes(ref))) throw new Error('QUIZ_SOURCE_EVIDENCE_CHANGED');
  const before = new Map(source.preferences.map(p => [p.key, p]));
  for (const previous of source.preferences.filter(p => p.origin === 'explicit')) {
    const next = profile.preferences.find(p => p.key === previous.key);
    if (!next || !samePreference(previous, next)) throw new Error('QUIZ_EXPLICIT_PREFERENCE_CHANGED');
  }
  for (const preference of profile.preferences) {
    if (!knownRefs(preference.evidenceRefs)) throw new Error('UNKNOWN_QUIZ_EVIDENCE');
    const previous = before.get(preference.key);
    if (previous && samePreference(previous, preference)) continue;
    if (preference.origin !== 'inferred') throw new Error('QUIZ_CANNOT_CREATE_EXPLICIT');
    if (!preference.evidenceRefs.includes(input.invocationEvidenceRef) || ![...byTurn.values()].some(ref => preference.evidenceRefs.includes(ref))) throw new Error('QUIZ_INFERENCE_NEEDS_USER_EVIDENCE');
    if (preference.evidenceRefs.some(ref => !profile.evidenceRefs.includes(ref))) throw new Error('QUIZ_PROFILE_MISSING_EVIDENCE');
  }
  throwIfAborted(signal);
  return { ...result, profile };
}

export interface PreferenceConfirmation {
  source: Profile;
  turns: Turn[];
  userEvidence: QuizInput['userEvidence'];
  nextRevision: string;
  confirmation: { turnId: string; key: string; value: string };
}
/** Trusted caller only: confirms its interpretation of an actual user turn. Never expose as an LLM tool.
 * Conflicting explicit instructions need caller/user resolution; this API chooses no tie-breaker.
 */
export function confirmQuizPreference(input: PreferenceConfirmation): Profile {
  const source = parseProfile(input.source);
  const turns = parseTurns(input.turns);
  const byTurn = checkUserEvidence(turns, input.userEvidence);
  const evidenceRef = byTurn.get(input.confirmation.turnId);
  if (!evidenceRef) throw new Error('QUIZ_CONFIRMATION_NEEDS_USER_TURN');
  const existing = source.preferences.find(p => p.key === input.confirmation.key);
  if (existing?.origin === 'explicit' && existing.value !== input.confirmation.value) throw new Error('CONFLICTING_EXPLICIT_QUIZ_PREFERENCE');
  if (input.nextRevision === source.revision) throw new Error('QUIZ_REVISION_NOT_ADVANCED');
  const preference = { key: input.confirmation.key, value: input.confirmation.value, origin: 'explicit' as const, evidenceRefs: [...new Set([...(existing?.origin === 'explicit' ? existing.evidenceRefs : []), evidenceRef])] };
  return parseProfile({ ...source, revision: input.nextRevision, evidenceRefs: [...new Set([...source.evidenceRefs, evidenceRef])], preferences: [...source.preferences.filter(p => p.key !== preference.key), preference] });
}
