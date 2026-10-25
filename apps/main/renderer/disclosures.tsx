import { useId, useState } from 'react';
import { resolveBindingRequirements, type BindingApplicability, type BindingApplicabilityEntry, type Capability, type SourceApp, type SourceProfile, type Target } from '../../../contracts/index.js';
import { SourceThumbnailSchema, type SourceThumbnail } from '../../../profiles/source-thumbnails.js';

/** Presentation props only. profile service owns the registry; host validates/resolves asset IDs. */
export interface SourceThumbnailMetadata {
  assetId: string;
  profileId: string;
  profileRevision: string;
  sourceApp: SourceApp;
  alt: string;
  caption: string;
  kind: 'source-capture' | 'illustration' | null;
  status: 'missing' | 'candidate' | 'available';
  approval: 'pending' | 'approved';
  evidenceRefs: string[];
}
export interface ResolvedSourceThumbnail {
  metadata: SourceThumbnailMetadata;
  /** Host-approved packaged URL, never an arbitrary local path or remote URL. */
  src: string;
}
export function usableSourceThumbnail(profile: SourceProfile, asset?: ResolvedSourceThumbnail | null): asset is ResolvedSourceThumbnail {
  const metadata = asset?.metadata;
  return !!metadata && metadata.profileId === profile.profileId && metadata.profileRevision === profile.revision &&
    metadata.sourceApp === profile.sourceApp && metadata.assetId === `source-before:${profile.profileId}:${profile.revision}` &&
    metadata.status === 'available' && metadata.approval === 'approved' &&
    (metadata.kind === 'source-capture' || metadata.kind === 'illustration') && !!metadata.alt.trim() &&
    !!metadata.caption.trim() && metadata.evidenceRefs.length > 0 && metadata.evidenceRefs.every(ref => !!ref.trim()) &&
    /^\.\/assets\/source-thumbnails\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:png|jpe?g|webp)$/.test(asset!.src);
}
export function SourceBeforeThumbnail({ profile, asset, metadata }: { profile: SourceProfile; asset?: ResolvedSourceThumbnail | null; metadata?: SourceThumbnail | null }) {
  const parsed = SourceThumbnailSchema.safeParse(metadata);
  const matched = parsed.success && parsed.data.profileId === profile.profileId && parsed.data.profileRevision === profile.revision && parsed.data.sourceApp === profile.sourceApp ? parsed.data : null;
  const canonicalAllowsAsset = metadata == null || !!(matched && asset && matched.status === 'available' && matched.approval === 'approved' &&
    matched.kind === asset.metadata.kind && matched.alt === asset.metadata.alt && matched.caption === asset.metadata.caption &&
    [...matched.evidenceRefs].sort().join('\n') === [...asset.metadata.evidenceRefs].sort().join('\n'));
  return <section aria-label="Before source interface" className="source-before">
    <h3>Before · Source layout</h3>
    {usableSourceThumbnail(profile, asset) && canonicalAllowsAsset ? <SourceImage key={`${profile.profileId}:${profile.revision}:${asset.metadata.assetId}:${asset.src}`} asset={asset} /> :
      <p role="status">Source thumbnail pending for {profile.label}. {matched ? `${matched.caption} ` : ''}
        {matched?.status === 'available' ? 'Approved metadata is available; the packaged image has not been connected.' : 'An approved image of this source layout has not been connected.'}</p>}
  </section>;
}
function SourceImage({ asset }: { asset: ResolvedSourceThumbnail }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed) return <p role="status">The approved source thumbnail could not be loaded. Source preview is unavailable.</p>;
  return <figure aria-busy={!loaded}>
    <img src={asset.src} alt={asset.metadata.alt} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
    {!loaded && <p role="status">Loading source thumbnail…</p>}
    <figcaption><strong>{asset.metadata.kind === 'source-capture' ? 'Prepared source capture' : 'Simulated source illustration'}</strong>
      <p>{asset.metadata.caption}</p>
      {asset.metadata.kind === 'illustration' && <p>This illustration is not an actual source-interface capture.</p>}
    </figcaption>
  </figure>;
}

export interface ToolExplanation {
  toolId: string;
  sourceAction?: string;
  capabilityId?: string;
  label: string;
  description: string;
  destinationLabel?: string;
  limitations: string[];
  evidenceRefs: string[];
}
export interface WorkflowDisclosure {
  /** Correlation for display metadata, including legacy catalogs without a policy. */
  scope: Pick<BindingApplicability, 'scenarioId' | 'source' | 'target'>;
  bindingApplicability?: BindingApplicability;
  /** Supplied independently by the trusted host. Never assembled from the policy/model text. */
  trustedEvidenceRefs: string[];
  catalog: readonly Capability[];
  tools: ToolExplanation[];
}
export interface DisclosureScope { scenarioId: string; profile: SourceProfile; target: Target }
/** host's resolver owns applicability semantics; local checks only associate display text. */
export function matchingDisclosure(scope: DisclosureScope, disclosure?: WorkflowDisclosure | null): disclosure is WorkflowDisclosure {
  if (!disclosure || disclosure.scope.scenarioId !== scope.scenarioId ||
    disclosure.scope.source.profileId !== scope.profile.profileId || disclosure.scope.source.revision !== scope.profile.revision ||
    disclosure.scope.source.sourceApp !== scope.profile.sourceApp || disclosure.scope.target.appId !== scope.target.appId ||
    disclosure.scope.target.adapterVersion !== scope.target.adapterVersion) return false;
  try {
    resolveBindingRequirements({ scenarioId: scope.scenarioId, source: scope.profile, target: scope.target,
      catalog: [...disclosure.catalog], evidenceRefs: disclosure.trustedEvidenceRefs,
      bindingApplicability: disclosure.bindingApplicability });
  } catch { return false; }
  const policy = disclosure.bindingApplicability;
  const trustedRefs = new Set(disclosure.trustedEvidenceRefs);
  const tools = disclosure!.tools;
  const describedActions = tools.flatMap(tool => tool.sourceAction ? [tool.sourceAction] : []);
  if (new Set(tools.map(tool => tool.toolId)).size !== tools.length || new Set(describedActions).size !== describedActions.length) return false;
  if (tools.some(tool => {
    if (!tool.sourceAction || !tool.capabilityId) return false;
    if (policy) {
      const entry = policy.entries.find(item => item.sourceAction === tool.sourceAction);
      return entry?.status !== 'mapped' || entry.capabilityId !== tool.capabilityId;
    }
    // Without a policy the canonical resolver has already required direct preservation.
    return !disclosure.catalog.some(capability => capability.id === tool.capabilityId && capability.kind === 'binding' && capability.bindingAction === tool.sourceAction);
  })) return false;
  return tools.every(tool => !!tool.label.trim() && !!tool.description.trim() && tool.evidenceRefs.length > 0 && tool.evidenceRefs.every(ref => trustedRefs.has(ref)) &&
    tool.limitations.every(text => !!text.trim()) && (!tool.sourceAction || Object.hasOwn(scope.profile.bindings, tool.sourceAction)) &&
    (!tool.capabilityId || disclosure!.catalog.some(capability => capability.id === tool.capabilityId)));
}
export function mappingLabel(entry: BindingApplicabilityEntry): string {
  return entry.status === 'mapped' ? (entry.relation === 'direct' ? 'Mapped to the same action' : 'Mapped to an equivalent action') :
    entry.status === 'unavailable' ? 'Unavailable in this destination' : 'Unchanged for this workflow';
}
export function ToolMappingDisclosure({ scope, disclosure }: { scope?: DisclosureScope | null; disclosure?: WorkflowDisclosure | null }) {
  if (!scope || !matchingDisclosure(scope, disclosure)) return <section aria-label="Tool mappings and limitations">
    <h3>Tool mappings and limitations</h3><p role="status">Mapping details pending. The runtime has not supplied matching tool explanations for this workflow.</p>
  </section>;
  const entries = disclosure.bindingApplicability?.entries;
  return <section aria-label="Tool mappings and limitations">
    <h3>Tool mappings and limitations</h3>
    <p>Lucienne explanations describe the host’s mapping plan. Native tooltip rendering has not been verified by this shell.</p>
    <ul className="tool-mapping-list">{Object.keys(scope.profile.bindings).map(sourceAction => {
      const entry = entries?.find(item => item.sourceAction === sourceAction);
      const tool = disclosure.tools.find(item => item.sourceAction === sourceAction);
      const limitations = [...new Set([...(entry?.limitation === undefined ? [] : [entry.limitation]), ...(tool?.limitations ?? [])])];
      return <li key={sourceAction}>
        <ToolTooltip label={tool?.label ?? sourceAction} description={tool?.description ?? 'Tool description pending.'}
          destinationLabel={tool?.destinationLabel} limitations={limitations} />
        <span>{entry ? mappingLabel(entry) : 'Mapped to the same action'} · Source shortcut: <kbd>{scope.profile.bindings[sourceAction]!.replace('Meta+', '⌘')}</kbd></span>
      </li>;
    })}
    {disclosure.tools.filter(tool => !tool.sourceAction).map(tool => <li key={`target:${tool.toolId}`}>
      <ToolTooltip label={tool.label} description={tool.description} destinationLabel={tool.destinationLabel} limitations={tool.limitations} />
      <span>Destination tool</span>
    </li>)}
    </ul>
  </section>;
}
function ToolTooltip({ label, description, destinationLabel, limitations }: Pick<ToolExplanation, 'label' | 'description' | 'destinationLabel' | 'limitations'>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <span className="tool-explanation" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); } }}>
    <button type="button" aria-describedby={id} aria-expanded={open} onClick={() => setOpen(true)}>{label} · Details</button>
    <span role="tooltip" id={id} hidden={!open} className="tool-tooltip">
      <span>{description}</span>
      {destinationLabel && <span>Destination: {destinationLabel}</span>}
      {limitations.length ? limitations.map(text => <em key={text} className="tool-limitation">{text}</em>) : <small>No tool-specific limitation information supplied.</small>}
    </span>
  </span>;
}
