import { useId } from 'react';
import type { RuntimeScenario } from '../../../contracts/bridge.js';
import type { SourceApp, SourceProfile, TargetApp } from '../../../contracts/index.js';
import { SourceBeforeThumbnail } from './disclosures.js';
import { labels } from './model.js';

export type WorkflowStep = 'source' | 'workspace' | 'destination';
export interface WorkflowPickerProps {
  step: WorkflowStep;
  profiles: readonly SourceProfile[];
  cases: readonly RuntimeScenario[];
  sourceApp?: SourceApp;
  profile?: SourceProfile;
  targetApp?: TargetApp;
  /** Approved preview destinations supplied by the caller when no case rows exist. */
  targets?: readonly TargetApp[];
  locked: boolean;
  onSource(sourceApp: SourceApp): void;
  onWorkspace(profileId: string): void;
  onTarget(targetApp: TargetApp): void;
  onBack(step: 'source' | 'workspace'): void;
}

function matchingCases(cases: readonly RuntimeScenario[], profile: SourceProfile): RuntimeScenario[] {
  return cases.filter(row => row.profileId === profile.profileId && row.personaId === profile.personaId &&
    row.sourceApp === profile.sourceApp && row.source.profileId === profile.profileId &&
    row.source.revision === profile.revision && row.source.sourceApp === profile.sourceApp &&
    row.source.personaId === profile.personaId && row.targetApp === row.target.appId);
}

/** Controlled draft choices only; the host remains responsible for selection and execution. */
export function WorkflowPicker({ step, profiles, cases, sourceApp, profile, targetApp, targets,
  locked, onSource, onWorkspace, onTarget, onBack }: WorkflowPickerProps) {
  const id = useId();
  const source = sourceApp ?? profile?.sourceApp;
  if (step === 'source') return <section aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>Choose a source app</h3>
    <p>Which app feels familiar?</p>
    <div className="controls">{[...new Set(profiles.map(item => item.sourceApp))].map(app =>
      <button key={app} type="button" disabled={locked} onClick={() => onSource(app)}>{labels[app]}</button>)}</div>
    {!profiles.length && <p role="status">Source apps are pending the workflow catalog.</p>}
  </section>;

  if (step === 'workspace') {
    const workspaces = profiles.filter(item => item.sourceApp === source);
    return <section aria-labelledby={`${id}-heading`}>
      <button type="button" disabled={locked} onClick={() => onBack('source')}>Back to source apps</button>
      <h3 id={`${id}-heading`}>Choose a workspace</h3>
      {source && <p>Source app: {labels[source]}</p>}
      <div className="selection-grid workspace-choices">{workspaces.map(item => {
        const rows = matchingCases(cases, item);
        const metadata = rows[0]?.sourceThumbnail;
        const consistent = rows.every(row => JSON.stringify(row.sourceThumbnail) === JSON.stringify(metadata));
        return <article key={`${item.profileId}:${item.revision}`} aria-label={item.label}>
          <h4>{item.label}</h4>
          <SourceBeforeThumbnail profile={item} metadata={consistent ? metadata : undefined} />
          <p>Profile provenance: {item.provenance.mode} · {item.provenance.provider}</p>
          <button type="button" disabled={locked}
            onClick={() => onWorkspace(item.profileId)}>Choose workspace: {item.label}</button>
        </article>;
      })}</div>
      {!workspaces.length && <p role="status">Matching workspaces are unavailable. Choose a source app to continue.</p>}
    </section>;
  }

  const selectedProfile = profile?.sourceApp === source ? profile : undefined;
  const rows = selectedProfile ? matchingCases(cases, selectedProfile) : [];
  const destinations = selectedProfile ? [...new Set(rows.length ? rows.map(row => row.targetApp) : targets ?? [])] : [];
  return <section aria-labelledby={`${id}-heading`}>
    <button type="button" disabled={locked} onClick={() => onBack('workspace')}>Back to workspaces</button>
    <h3 id={`${id}-heading`}>Choose a destination</h3>
    {selectedProfile ? <p>{labels[selectedProfile.sourceApp]} · {selectedProfile.label}</p> :
      <p role="status">Choose a workspace before choosing a destination.</p>}
    <ul>{destinations.map(app => {
      const matches = rows.filter(row => row.targetApp === app);
      const row = matches.length === 1 ? matches[0] : undefined;
      const available = row?.selectable === true;
      const description = available ? 'Configured; native checks pending.' : row ?
        row.reason ?? 'Unavailable in this runtime.' : 'Matching workflow metadata is unavailable.';
      return <li key={app}>
        <button type="button" disabled={locked} aria-pressed={targetApp === app} aria-describedby={`${id}-${app}`}
          onClick={() => onTarget(app)}>{labels[app]}{!available && ' · Unavailable'}</button>
        <p id={`${id}-${app}`}>{description}</p>
      </li>;
    })}</ul>
    {selectedProfile && !destinations.length && <p role="status">No destinations have been supplied for this workspace.</p>}
  </section>;
}
