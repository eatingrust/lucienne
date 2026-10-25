import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompanionController } from './controller.js';
import { present } from './model.js';
import { MAX_PAIRING_FILE_BYTES, PairingFileError, parsePairingFile } from './pairing-file.js';
import type { PairingFileProblem, PairingFileTarget } from './pairing-file.js';
const markUrl = new URL('./assets/lucienne-mark.svg', import.meta.url).href;

export function CompanionApp({ controller, fixture = false, clearPairing, pairingTarget }: { controller: CompanionController; fixture?: boolean; clearPairing?: () => void; pairingTarget?: PairingFileTarget }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const view = present(state);
  const [code, setCode] = useState('');
  const [fileProblem, setFileProblem] = useState<PairingFileProblem | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const fileGeneration = useRef(0);
  useEffect(() => () => { fileGeneration.current++; }, []);
  const cancelFile = () => { fileGeneration.current++; setReadingFile(false); setFileProblem(null); };
  const readPairingFile = async (file: File) => {
    if (!pairingTarget || state.busy || readingFile) return;
    const active = ++fileGeneration.current;
    setReadingFile(true); setFileProblem(null); setCode('');
    try {
      if (file.size > MAX_PAIRING_FILE_BYTES) throw new PairingFileError('invalid-file');
      const text = await file.text();
      if (active !== fileGeneration.current) return;
      const token = parsePairingFile(text, pairingTarget);
      setReadingFile(false);
      await controller.pair(token);
    } catch (error) {
      if (active === fileGeneration.current) setFileProblem(error instanceof PairingFileError ? error.code : 'invalid-file');
    } finally { if (active === fileGeneration.current) setReadingFile(false); }
  };
  const showPairing = state.status === 'pairing' || state.status === 'expired' || (state.status === 'error' && !state.reconnect);
  return <main>
    <header className="companion-header">
      <img className="lucienne-mark" src={markUrl} width="112" height="112" alt="" />
      <div><h1>Lucienne companion</h1><p>Follow the workflow on the main Mac.</p></div>
    </header>
    {fixture && <aside role="note"><strong>Fixture verification</strong> · Synthetic events. No native application is connected.</aside>}
    <p>Display connection: <strong>{view.connection}</strong></p>
    <section aria-live="polite" aria-atomic="true">
      <h2>{view.heading}</h2>
      {view.idle && <p>Idle display. Waiting for the main Mac to begin.</p>}
      {state.status === 'unconfigured' && <p>The station connection must be configured before this display can pair.</p>}
      {state.status === 'stale' && <p>Current session details are hidden until fresh updates arrive.</p>}
      {state.status === 'expired' && <p>Enter a new pairing code from the main Mac.</p>}
      {view.failed && <p>Continue on the main Mac to resolve the reported problem.</p>}
      {view.target && <p>Destination: <strong>{view.target}</strong></p>}
      {view.mode && <p>{view.mode}</p>}
      {view.evidence && <p>{view.evidence}</p>}
      {view.remaining && <p>{view.remaining}</p>}
      {view.gap && <p>Some updates were missed. Showing only the latest station snapshot.</p>}
    </section>
    {state.problem && <p role="alert">{ {
      pairing: 'Pairing was not confirmed. Retry the saved attempt, or use a new code from the main Mac.',
      storage: 'Private session storage is unavailable or invalid. Clear pairing to try again in this tab.',
      'invalid-code': 'Enter the complete pairing code from the main Mac.',
      connection: 'The display could not connect. Retry the connection.',
    }[state.problem] }</p>}
    {showPairing && <form onSubmit={event => { event.preventDefault(); if (readingFile) return; const value = code; cancelFile(); setCode(''); void controller.pair(value); }}>
      <label htmlFor="pairing-code">Private pairing code</label>
      <input id="pairing-code" type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" value={code}
        disabled={state.busy || readingFile} onChange={event => { cancelFile(); setCode(event.target.value); }} aria-describedby="pairing-help" />
      <p id="pairing-help">Enter the code shown on the main Mac. Keep it private.</p>
      <button type="submit" disabled={state.busy || readingFile || !code.trim()}>{state.busy ? 'Pairing…' : 'Pair display'}</button>
      {pairingTarget && <>
        <label htmlFor="pairing-file">Open private pairing file</label>
        <input id="pairing-file" type="file" accept=".json,application/json" disabled={state.busy || readingFile}
          onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void readPairingFile(file); }} />
        <p>Use the private file from the main Mac.</p>
      </>}
      {readingFile && <p role="status">Reading private pairing file…</p>}
      {fileProblem && <p role="alert">{{
        'invalid-file': 'This pairing file could not be read. Use the original file from the main Mac.',
        'expired-file': 'This pairing file has expired. Request a fresh file from the main Mac.',
        'wrong-station': 'This file is for a different station. Use a file for this display’s configured station.',
      }[fileProblem]}</p>}
    </form>}
    <nav aria-label="Display connection controls">
      {state.retryPairing && <button onClick={() => { cancelFile(); void controller.retryPairing(); }} disabled={state.busy || readingFile}>Retry saved pairing</button>}
      {state.reconnect && <button onClick={controller.reconnect}>Reconnect display</button>}
      {state.status !== 'unconfigured' && <button onClick={() => { cancelFile(); setCode(''); (clearPairing ?? controller.forget)(); }}>Clear pairing</button>}
    </nav>
    <footer><p>This display follows the main Mac. Session controls stay on the main Mac.</p></footer>
  </main>;
}
