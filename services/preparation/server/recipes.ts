import { createHash } from 'node:crypto';
import { assertRoute, SourceProfileSchema, TargetSchema } from '../../../contracts/index.js';
import type { SourceProfile, Target } from '../../../contracts/index.js';
import { getProfile } from '../../../profiles/index.js';
import { officialCorpusForProfile, personaCorpus } from '../context.js';
import type { EvidenceDocument, RetrievalQuery } from '../retrieval.js';
import { selectCorpus } from '../retrieval.js';

type Recipe = 'source-reference' | 'target-reference' | 'persona';

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('INVALID_SOURCE_FINGERPRINT');
  return serialized;
}

/** Object order is irrelevant; array order and all profile content remain significant. */
export function sourceFingerprint(source: SourceProfile): string {
  return createHash('sha256').update(canonicalJson(source)).digest('hex');
}

function sameReferences(a: string[], b: string[]): boolean {
  return a.length === new Set(a).size && b.length === new Set(b).size
    && a.length === b.length && a.every(ref => b.includes(ref));
}

/** The authenticated host caller owns quiz history and confirmation, not this catalog guard. */
export function validateServiceSource(raw: unknown): SourceProfile {
  let source: SourceProfile;
  try {
    const serialized = JSON.stringify(raw);
    if (serialized === undefined || serialized.length > 64_000) throw Error();
    source = SourceProfileSchema.parse(raw);
    if (Object.keys(source.bindings).length > 64
        || new Set(source.preferences.map(preference => preference.key)).size !== source.preferences.length) throw Error();
  } catch { throw new Error('INVALID_SERVICE_SOURCE'); }

  let preset: SourceProfile;
  try { preset = getProfile(source.profileId); }
  catch { throw new Error('UNKNOWN_SERVICE_SOURCE'); }
  for (const key of ['version', 'profileId', 'sourceApp', 'personaId', 'label'] as const) {
    if (source[key] !== preset[key]) throw new Error('SERVICE_SOURCE_IDENTITY_CHANGED');
  }
  if (preset.provenance.mode !== 'simulated' || source.provenance.mode !== preset.provenance.mode
      || source.provenance.provider !== preset.provenance.provider
      || !sameReferences(source.provenance.evidenceRefs, preset.provenance.evidenceRefs)) {
    throw new Error('SERVICE_SOURCE_PROVENANCE_CHANGED');
  }
  if (canonicalJson(source.bindings) !== canonicalJson(preset.bindings)) throw new Error('SERVICE_SOURCE_BINDINGS_CHANGED');
  if (preset.evidenceRefs.some(ref => !source.evidenceRefs.includes(ref))) throw new Error('SERVICE_SOURCE_EVIDENCE_REMOVED');
  for (const explicit of preset.preferences.filter(preference => preference.origin === 'explicit')) {
    const current = source.preferences.find(preference => preference.key === explicit.key);
    if (!current || current.origin !== 'explicit' || current.value !== explicit.value
        || explicit.evidenceRefs.some(ref => !current.evidenceRefs.includes(ref))) {
      throw new Error('SERVICE_SOURCE_EXPLICIT_CHANGED');
    }
  }
  return source;
}

/** Only reviewed local corpus metadata chooses app/version scope; no client-supplied corpus or URL. */
export function selectContextRecipe(source: SourceProfile, target: Target, recipe: Recipe): {
  documents: EvidenceDocument[]; query: RetrievalQuery;
} {
  const profile = validateServiceSource(source);
  const destination = TargetSchema.parse(target);
  assertRoute(profile.sourceApp, destination.appId);
  if (!['source-reference', 'target-reference', 'persona'].includes(recipe)) throw new Error('INVALID_PREPARATION_RECIPE');

  if (recipe === 'persona') {
    const documents = personaCorpus(profile);
    if (!documents.length) throw new Error('PREPARATION_PERSONA_UNAVAILABLE');
    const query: RetrievalQuery = {
      profile: profile.profileId, app: profile.sourceApp, app_version: documents[0].metadata.app_version,
      profile_revision: profile.revision,
      query: 'Source persona preferences for panel placement, work area size and tool density.', topK: 1,
    };
    return { documents: selectCorpus(documents, query), query };
  }

  const app = recipe === 'source-reference' ? profile.sourceApp : destination.appId;
  const relevant = officialCorpusForProfile(profile.profileId).filter(document => document.metadata.app === app);
  if (!relevant.length) throw new Error(recipe === 'source-reference'
    ? 'PREPARATION_SOURCE_REFERENCE_UNAVAILABLE' : 'PREPARATION_TARGET_REFERENCE_UNAVAILABLE');
  // Stable reviewed-version selection, not a claim about the latest or installed application.
  const version = [...new Set(relevant.map(document => document.metadata.app_version))].sort()[0];
  const query: RetrievalQuery = {
    profile: profile.profileId, app, app_version: version,
    query: recipe === 'source-reference'
      ? `Documented ${app} workspace concepts and default shortcut bindings.`
      : `Documented ${app} workspace layout, panels, tools and shortcut configuration.`,
    topK: 1,
  };
  return { documents: selectCorpus(relevant, query), query };
}
