import { z } from 'zod';
import { SourceAppSchema } from '../contracts/index.js';
import { getProfile, loadProfiles, plannedCases } from './index.js';
import assetRegistry from './source-thumbnail-assets.json' with { type: 'json' };

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const assetIdSchema = z.string().min(1).max(336).regex(/^[a-zA-Z0-9._:/-]+$/);
const text = z.string().trim().min(1).max(600);
const common = { version: z.literal(1), assetId: assetIdSchema, profileId: id, profileRevision: id,
  sourceApp: SourceAppSchema, alt: text, caption: text, evidenceRefs: z.array(id).min(1).max(32) };
const file = z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192), mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']) });
const supplied = { ...common, status: z.enum(['candidate', 'available']), approval: z.enum(['pending', 'approved']), file,
  reviewEvidenceRef: id.optional() };

/** Metadata only: approved asset IDs are resolved to URLs by the trusted host/site packager. */
export const SourceThumbnailSchema = z.union([
  z.strictObject({ ...common, kind: z.null(), status: z.literal('missing'), approval: z.literal('pending'),
    reason: z.enum(['source-asset-not-provided', 'profile-revision-unavailable']) }),
  z.strictObject({ ...supplied, kind: z.literal('source-capture'), provenance: z.strictObject({
    origin: z.literal('native-source-application'), sourceAppVersion: text, capturedAt: z.iso.datetime(), captureEvidenceRef: id,
  }) }),
  z.strictObject({ ...supplied, kind: z.literal('illustration'), provenance: z.strictObject({
    origin: z.literal('synthetic-reference'), createdAt: z.iso.datetime(), creationEvidenceRef: id,
  }) }),
]).superRefine((value, ctx) => {
  // Refinements may receive strings already marked invalid; never throw from safeParse.
  if (value.assetId !== `source-before:${value.profileId}:${value.profileRevision}`) ctx.addIssue({ code: 'custom', message: 'Asset identity mismatch' });
  if (new Set(value.evidenceRefs).size !== value.evidenceRefs.length) ctx.addIssue({ code: 'custom', message: 'Duplicate evidence reference' });
  if (value.status === 'missing') return;
  if ((value.status === 'available') !== (value.approval === 'approved')) ctx.addIssue({ code: 'custom', message: 'Availability requires approval' });
  const originRef = value.kind === 'source-capture' ? value.provenance.captureEvidenceRef : value.provenance.creationEvidenceRef;
  if (!value.evidenceRefs.includes(originRef)) ctx.addIssue({ code: 'custom', message: 'Missing origin evidence' });
  if (value.status === 'available' && (!value.reviewEvidenceRef || !value.evidenceRefs.includes(value.reviewEvidenceRef))) ctx.addIssue({ code: 'custom', message: 'Missing asset review evidence' });
});
export type SourceThumbnail = z.infer<typeof SourceThumbnailSchema>;

export function sourceThumbnailAssetId(profileId: string, profileRevision: string): string {
  // Asset IDs are separate from evidence/capability IDs; keep both full source identity fields.
  const result = `source-before:${id.parse(profileId)}:${id.parse(profileRevision)}`;
  return assetIdSchema.parse(result);
}

/** One reviewed candidate per exact source/profile/revision; ambiguity never chooses an image. */
export function parseSourceThumbnailRegistry(raw: unknown): SourceThumbnail[] {
  const registry = z.strictObject({ version: z.literal(1), assets: z.array(SourceThumbnailSchema).max(128) }).parse(raw);
  const seen = new Set<string>();
  for (const asset of registry.assets) {
    const profile = getProfile(asset.profileId);
    if (asset.sourceApp !== profile.sourceApp || asset.status === 'missing' || seen.has(asset.assetId)) throw new Error('INVALID_SOURCE_THUMBNAIL_REGISTRY');
    seen.add(asset.assetId);
  }
  return registry.assets;
}

export function sourceThumbnailForProfile(profileId: string, profileRevision?: string): SourceThumbnail {
  const profile = getProfile(profileId);
  const revision = profileRevision === undefined ? profile.revision : id.parse(profileRevision);
  const assetId = sourceThumbnailAssetId(profile.profileId, revision);
  const suppliedAsset = parseSourceThumbnailRegistry(assetRegistry).find(asset => asset.assetId === assetId);
  if (suppliedAsset) return structuredClone(suppliedAsset);
  return SourceThumbnailSchema.parse({ version: 1, assetId, profileId: profile.profileId, profileRevision: revision,
    sourceApp: profile.sourceApp, alt: `${profile.label} — source workspace preview unavailable`,
    caption: 'Source workspace image pending.', evidenceRefs: [...profile.provenance.evidenceRefs],
    kind: null, status: 'missing', approval: 'pending',
    reason: revision === profile.revision ? 'source-asset-not-provided' : 'profile-revision-unavailable' });
}

/** Reuse the same source workspace for its three destinations; never relabel it as a target result. */
export function scenarioSourceThumbnails() {
  const byProfile = new Map(loadProfiles().map(profile => [profile.profileId, sourceThumbnailForProfile(profile.profileId, profile.revision)]));
  return plannedCases().map(scenario => ({ scenarioId: scenario.scenarioId, targetApp: scenario.targetApp,
    thumbnail: structuredClone(byProfile.get(scenario.profileId)!) }));
}
