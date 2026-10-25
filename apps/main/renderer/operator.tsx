import { useEffect, useState } from 'react';
import type { Command, DesktopBridge, RuntimeState } from '../../../contracts/bridge.js';
import './style.css';
declare global { interface Window { lucienne?: DesktopBridge } }
export function OperatorApp() {
  const [state, setState] = useState<RuntimeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const bridge = window.lucienne;
    if (!bridge) return;
    let receivedUpdate = false;
    const unsubscribe = bridge.subscribe(next => { receivedUpdate = true; setState(next); });
    bridge.getState().then(next => { if (!receivedUpdate) setState(next); }).catch(() => setError('BRIDGE_UNAVAILABLE'));
    return unsubscribe;
  }, []);
  async function send(command: Command) {
    if (!window.lucienne) return;
    setSending(true); setError(null);
    try { const result = await window.lucienne.command(command); if (!result.ok) setError(result.code ?? 'COMMAND_REJECTED'); }
    catch { setError('BRIDGE_UNAVAILABLE'); } finally { setSending(false); }
  }
  const snapshot = state?.snapshot;
  const phase = snapshot?.phase ?? 'idle';
  const busy = sending || !!snapshot?.busy || !!state?.qa.running;
  return <main>
    <p>Lucienne · Engineering scaffold</p>
    <h1>Session lifecycle</h1>
    <p>This is the engineering harness for the registered native workflows. Product design remains paused.</p>
    <p role="status">{state?.fixtureEnabled ? 'Prepared synthetic fixture enabled. No creative app or desktop is changed.' :
      state?.nativeAdapterAvailable ? `Native workflows available. Initial planner: ${state.nativePrepared ? 'authored prepared recipe' : 'live Factory'}. Chat: ${state.chatAvailable ? 'live Claude' : 'credential required'}.` :
      `Native adapter unavailable: ${state?.nativeStartupError ?? 'launch with --krita in the lucienne account'}.`}</p>
    {state?.qa.enabled && state.nativeAdapterAvailable && state.nativeStartupError && <p role="alert">Default workflow unavailable: {state.nativeStartupError}. Select another supported workflow.</p>}
    {!window.lucienne && <p>Browser preview only. Open the Electron app to use the local session bridge.</p>}
    <dl><dt>Phase</dt><dd>{phase}</dd><dt>Exploration remaining</dt><dd>{Math.ceil((snapshot?.remainingMs ?? 60000) / 1000)} seconds</dd>
      <dt>Evidence</dt><dd>{snapshot?.evidenceKind ?? 'none'}</dd></dl>
    {(state?.fixtureEnabled || state?.nativeAdapterAvailable) && <div className="controls">
      {state.qa.enabled && <>
      <label>Native QA workflow
        <select value={state.selection?.scenarioId ?? ''}
          disabled={busy || phase !== 'idle' || state.qa.stage !== 'not-started'}
          onChange={event => void send({ type: 'select-scenario', scenarioId: event.target.value })}>
          <option value="" disabled>Select a workflow</option>
          {state.catalog?.cases.map(row => <option key={row.scenarioId} value={row.scenarioId} disabled={!row.selectable}>
            {row.label} → {row.targetApp}{row.selectable ? '' : ` — ${row.reason ?? 'QA unavailable'}`}
          </option>)}
        </select>
      </label>
      <button disabled={busy || phase !== 'idle' || !state.selection || !state.chatAvailable || state.qa.stage !== 'not-started'} onClick={() => void send({ type: 'start-native-qa' })}>Run one native QA attempt</button></>}
      {!state.qa.enabled && <>
      <button disabled={busy || phase !== 'idle'} onClick={() => void send({ type: state.fixtureEnabled ? 'select-fixture' : 'select-krita' })}>{state.fixtureEnabled ? 'Select fixture' : 'Select Photoshop collage → Krita'}</button>
      <button disabled={busy || phase !== 'selected'} onClick={() => void send({ type: 'translate' })}>{state.fixtureEnabled ? 'Apply fixture' : 'Translate'}</button>
      <button disabled={busy || phase !== 'ready'} onClick={() => void send({ type: 'open-chat' })}>Pause for chat</button>
      <button disabled={busy || phase !== 'chat' || !state.chatAvailable} onClick={() => void send({ type: 'chat', intent: 'move-key-panels' })}>Move Layers to the right</button>
      <button disabled={busy || phase !== 'chat' || !state.chatAvailable} onClick={() => void send({ type: 'chat', intent: 'enlarge-work-area' })}>Give the canvas more room</button>
      <button disabled={busy || phase !== 'chat' || !state.chatAvailable} onClick={() => void send({ type: 'chat', intent: 'simplify-tools' })}>Simplify tools</button>
      <button disabled={busy || phase !== 'chat'} onClick={() => void send({ type: 'close-chat' })}>Resume unchanged</button>
      <button disabled={phase === 'idle' || phase === 'resetting'} onClick={() => void send({ type: 'reset' })}>{state.fixtureEnabled ? 'Reset fixture' : 'Full reset to desktop'}</button>
      </>}
    </div>}
    {state?.qa.enabled && <aside>
      <p>Native QA: {state.qa.stage}</p>
      {state.qa.running && <button disabled={sending} onClick={() => void send({ type: 'reset' })}>Cancel QA and restore</button>}
      {state.qa.pending && <><p>{state.qa.pending.instruction}</p>
        <button disabled={sending} onClick={() => void send({ type: 'complete-qa-step', id: state.qa.pending!.id })}>Action complete — collect readback</button></>}
      {state.qa.result && <p>{state.qa.result}. Restart the app before another attempt.</p>}
    </aside>}
    {phase === 'closing' && <aside role="status"><h2>Exploration finished</h2><p>Reset in {Math.ceil((snapshot?.closingRemainingMs ?? 0) / 1000)} seconds.</p></aside>}
    {(error || snapshot?.lastError) && <p role="alert">{error ?? snapshot?.lastError}</p>}
    {!!state?.desktopBlockers?.length && <aside aria-label="Windows blocking desktop cleanup">
      <p>{state.qa.stage === 'not-started' && ['idle', 'selected'].includes(phase)
        ? 'Close these windows in the lucienne account, then retry the action:'
        : 'Close these windows in the lucienne account, then quit Lucienne to retry cleanup:'}</p>
      <ul>{state.desktopBlockers.map((blocker, index) => <li key={`${blocker.pid}-${index}`}>{blocker.appId} · process {blocker.pid} · window layer {blocker.layer}</li>)}</ul>
      <p>This is a diagnostic list, not confirmation that reset passed.</p>
    </aside>}
  </main>;
}
