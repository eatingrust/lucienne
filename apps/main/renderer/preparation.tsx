import { useState } from 'react';
import type { Command, RuntimeServices, RuntimeState } from '../../../contracts/bridge.js';
import { activeCase } from './catalog.js';

type PrepareCommand = Extract<Command, { type: 'prepare-context' }>;
export type ContextRecipe = PrepareCommand['recipe'];
export type ContextRetrieval = PrepareCommand['retrieval'];
export interface PreparationPanelProps {
  runtime: RuntimeState | null;
  pending: Command['type'] | null;
  onCommand(command: Command): Promise<boolean>;
}
const recipes: readonly { value: ContextRecipe; label: string }[] = [
  { value: 'source-reference', label: 'Source application reference' },
  { value: 'target-reference', label: 'Destination application reference' },
  { value: 'persona', label: 'Persona context' },
  { value: 'apify-reference', label: 'Reviewed Apify reference' },
];
const retrievals: readonly { value: ContextRetrieval; label: string }[] = [
  { value: 'local-curated', label: 'Local curated references' },
  { value: 'moss', label: 'Moss retrieval' },
];
const sessionLabels: Record<RuntimeServices['session']['status'], string> = {
  starting: 'Connecting', connected: 'Connected', offline: 'Offline', overflow: 'Queue capacity reached',
  closed: 'Closed', disabled: 'Disabled', unavailable: 'Unavailable',
};
const preparationLabels: Record<RuntimeServices['preparation']['status'], string> = {
  starting: 'Starting', available: 'Available', unavailable: 'Unavailable', 'recovery-required': 'Recovery required', closed: 'Closed',
};
function recoveryRequired(runtime: RuntimeState): boolean {
  const preparation = runtime.services?.preparation;
  return !!preparation?.recoveryRequired || preparation?.status === 'recovery-required' || !!runtime.quiz?.recoveryRequired;
}
function ownedByQA(runtime: RuntimeState): boolean { return runtime.qa.enabled || runtime.qa.running; }

/** The host binds source, destination, run and context payload. UI supplies finite choices only. */
export function prepareContextCommand(runtime: RuntimeState | null, pending: Command['type'] | null,
  recipe: ContextRecipe, retrieval: ContextRetrieval): PrepareCommand | null {
  const preparation = runtime?.services?.preparation;
  if (!runtime || !preparation || pending || !runtime.nativeAdapterAvailable || ownedByQA(runtime) || recoveryRequired(runtime) ||
    runtime.snapshot.phase !== 'selected' || runtime.snapshot.busy || !activeCase(runtime) ||
    preparation.status !== 'available' || preparation.busy || ['preparing', 'ready'].includes(preparation.context.status) ||
    !recipes.some(item => item.value === recipe) || !retrievals.some(item => item.value === retrieval) ||
    (recipe === 'apify-reference' && !preparation.capabilities.apifyArtifact) ||
    (retrieval === 'moss' && !preparation.capabilities.moss)) return null;
  return { type: 'prepare-context', recipe, retrieval };
}

/** An in-flight optional request must not disable its own cancellation control. */
export function canCancelPreparation(runtime: RuntimeState | null, pending: Command['type'] | null): boolean {
  const preparation = runtime?.services?.preparation;
  if (!runtime || !preparation || ownedByQA(runtime) || recoveryRequired(runtime) ||
    preparation.status === 'closed' || !['idle', 'selected'].includes(runtime.snapshot.phase) || runtime.snapshot.busy ||
    (pending !== null && pending !== 'prepare-context' && pending !== 'preparation-status')) return false;
  return pending === 'prepare-context' || pending === 'preparation-status' || preparation.context.status !== 'none' ||
    (runtime.snapshot.phase === 'selected' && preparation.busy);
}

export function canRefreshPreparation(runtime: RuntimeState | null, pending: Command['type'] | null): boolean {
  const preparation = runtime?.services?.preparation;
  return !!runtime && !!preparation && !pending && !ownedByQA(runtime) && !recoveryRequired(runtime) &&
    preparation.status !== 'closed' && preparation.status !== 'starting' && !preparation.busy && !runtime.snapshot.busy &&
    !['resetting', 'error'].includes(runtime.snapshot.phase);
}

export function PreparationPanel({ runtime, pending, onCommand }: PreparationPanelProps) {
  const [recipe, setRecipe] = useState<ContextRecipe>('source-reference');
  const [retrieval, setRetrieval] = useState<ContextRetrieval>('local-curated');
  const services = runtime?.services;
  const preparation = services?.preparation;
  const recovery = !!runtime && recoveryRequired(runtime);
  const command = prepareContextCommand(runtime, pending, recipe, retrieval);
  const locked = !preparation || !!pending || preparation.busy || recovery || !!runtime?.snapshot.busy || !!runtime && ownedByQA(runtime);
  return <section className="panel" aria-label="Optional preparation and session services">
    <h2>Optional preparation</h2>
    {services ? <p>Session connection: <strong>{sessionLabels[services.session.status]}</strong>. Queued updates: {services.session.queued}.</p> :
      <p role="status">Session and preparation summaries are unavailable from this runtime.</p>}
    {preparation && <>
      <p>Preparation service: <strong>{preparationLabels[preparation.status]}</strong> · {preparation.mode === 'local' ? 'Local service' : 'Hosted service'}.</p>
      <details><summary>Configured preparation capabilities</summary><ul>
        <li>Curated reference context: available</li>
        <li>Moss retrieval: {preparation.capabilities.moss ? 'available' : 'unavailable'}</li>
        <li>LLM quiz: {preparation.capabilities.quiz ? 'available' : 'unavailable'}</li>
        <li>Image preparation: {preparation.capabilities.image ? 'available' : 'unavailable'}</li>
        <li>Reviewed Apify reference: {preparation.capabilities.apifyArtifact ? 'available' : 'unavailable'}</li>
      </ul></details>
      <div role="status" aria-live="polite">
        <p>{preparation.context.status === 'none' ? 'No optional context prepared.' :
          preparation.context.status === 'preparing' ? 'Preparing optional context.' :
            preparation.context.status === 'ready' ? 'Optional context is ready.' :
              'Optional context preparation failed. Retry, or clear optional preparation before translating without it.'}</p>
        {preparation.context.recipe && <p>Context: {recipes.find(item => item.value === preparation.context.recipe)?.label} · {retrievals.find(item => item.value === preparation.context.retrieval)?.label ?? 'Retrieval not reported'}.</p>}
        <p>Context evidence records: {preparation.context.evidenceCount}.</p>
      </div>
      {recovery ? <p role="alert">Optional preparation needs recovery. Use the main reset control before continuing; this panel cannot confirm recovery.</p> :
        runtime?.snapshot.phase !== 'selected' || !activeCase(runtime) ? <p>Select a matching workflow before preparing optional context.</p> : null}
      <div className="selection-grid">
        <label>Context recipe<select value={recipe} disabled={locked} onChange={event => setRecipe(event.target.value as ContextRecipe)}>
          {recipes.map(item => <option key={item.value} value={item.value} disabled={item.value === 'apify-reference' && !preparation.capabilities.apifyArtifact}>
            {item.label}{item.value === 'apify-reference' && !preparation.capabilities.apifyArtifact ? ' — unavailable' : ''}
          </option>)}
        </select></label>
        <label>Context retrieval<select value={retrieval} disabled={locked} onChange={event => setRetrieval(event.target.value as ContextRetrieval)}>
          {retrievals.map(item => <option key={item.value} value={item.value} disabled={item.value === 'moss' && !preparation.capabilities.moss}>
            {item.label}{item.value === 'moss' && !preparation.capabilities.moss ? ' — unavailable' : ''}
          </option>)}
        </select></label>
      </div>
      <p>Local curated references are an explicit choice. If Moss is unavailable, choose local references yourself before starting.</p>
      <div className="controls">
        <button disabled={!command} onClick={() => { if (command) void onCommand(command); }}>Prepare optional context</button>
        <button disabled={!canCancelPreparation(runtime, pending)} onClick={() => void onCommand({ type: 'cancel-preparation' })}>
          {preparation.context.status === 'ready' || preparation.context.status === 'failed' ? 'Clear optional preparation' : 'Cancel optional preparation'}
        </button>
        <button disabled={!canRefreshPreparation(runtime, pending)} onClick={() => void onCommand({ type: 'preparation-status' })}>Refresh preparation status</button>
      </div>
      {preparation.code && <details><summary>Preparation diagnostic</summary><code>{preparation.code}</code></details>}
    </>}
  </section>;
}
