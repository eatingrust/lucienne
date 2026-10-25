import type { CommittedPatchMetadata, SessionSnapshot } from '../../../core/session.js';

/** Display filter only. host owns creating receipts after independent readback. */
export function visibleCommittedPatch(snapshot?: SessionSnapshot | null): CommittedPatchMetadata | null {
  const receipt = snapshot?.committedPatch;
  if (!snapshot || !receipt || !snapshot.runId || receipt.runId !== snapshot.runId ||
    !['ready', 'chat', 'closing'].includes(snapshot.phase) || !['native', 'fixture'].includes(snapshot.evidenceKind) ||
    !receipt.requestId?.trim() || !Number.isInteger(receipt.generation) || receipt.generation < 0 ||
    !Array.isArray(receipt.limitations) || receipt.limitations.length > 12 ||
    receipt.limitations.some(text => typeof text !== 'string' || !text.trim() || text.length > 600)) return null;
  return receipt;
}

export function CommittedLimitations({ snapshot }: { snapshot?: SessionSnapshot | null }) {
  const receipt = visibleCommittedPatch(snapshot);
  if (!receipt || !snapshot) return null;
  const fixture = snapshot.evidenceKind === 'fixture';
  const pendingChange = snapshot.phase === 'chat' && snapshot.busy;
  return <section aria-label={fixture ? 'Simulated result limitations' : 'Verified native result limitations'}>
    <h3>{fixture ? 'Last simulated result' : 'Last verified native result'}</h3>
    <p>{fixture ? 'Fixture readback only. No native application change is confirmed.' : 'Native readback confirmed this applied result.'}</p>
    {pendingChange && <p role="status">A new chat change is still in progress. These limitations belong to the previous {fixture ? 'simulated' : 'verified native'} result.</p>}
    {!pendingChange && snapshot.lastError && <p>The latest request did not complete successfully. This remains the last {fixture ? 'simulated' : 'verified native'} result.</p>}
    {receipt.limitations.length > 0 ? <ul>{receipt.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul> :
      <p>No limitations were reported with this result.</p>}
  </section>;
}
