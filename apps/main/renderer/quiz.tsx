import { useEffect, useRef, useState } from 'react';
import type { SourceProfile } from '../../../contracts/index.js';
import type { RuntimeQuiz } from '../../../contracts/bridge.js';

export type QuizViewState = NonNullable<RuntimeQuiz['state']>;
export type QuizIdentity = Pick<QuizViewState, 'quizId' | 'requestId' | 'sourceProfileId' | 'sourceRevision'>;
export type QuizTurn = QuizViewState['turns'][number];
export type QuizResult = NonNullable<QuizViewState['result']>;
type Action = void | Promise<void>;
export interface QuizPanelProps {
  source: SourceProfile;
  state?: QuizViewState | null;
  available?: boolean;
  disabled?: boolean;
  /** Change on session reset, even when the selected source is unchanged. */
  resetKey?: string | number;
  onStart?: (input: Pick<QuizIdentity, 'sourceProfileId' | 'sourceRevision'>) => Action;
  onAnswer?: (input: QuizIdentity & { text: string }) => Action;
  onCancel?: (input: QuizIdentity) => Action;
  onAccept?: (input: QuizIdentity & { resultRevision: string }) => Action;
}

// Canonical host state owns IDs, transcript, evidence and accepted profile revisions.
export function matchingQuiz(source: SourceProfile, state?: QuizViewState | null): QuizViewState | null {
  return state?.sourceProfileId === source.profileId && state.sourceRevision === source.revision ? state : null;
}
export function quizScopeKey(source: SourceProfile, state: QuizViewState | null, resetKey: string | number = 0): string {
  return JSON.stringify([source.profileId, source.revision, state?.quizId, state?.requestId, state?.status, resetKey]);
}
function identity(state: QuizViewState): QuizIdentity {
  return { quizId: state.quizId, requestId: state.requestId, sourceProfileId: state.sourceProfileId, sourceRevision: state.sourceRevision };
}
export function quizAnswer(source: SourceProfile, state: QuizViewState | null, draft: string): (QuizIdentity & { text: string }) | null {
  const current = matchingQuiz(source, state);
  const text = draft.trim();
  if (!current || current.status !== 'question' || !current.quizId || !current.requestId ||
      current.result?.status !== 'continue' || !current.result.question?.trim() || !text || text.length > 2000) return null;
  return { ...identity(current), text };
}
export function quizAcceptedRevision(source: SourceProfile, state: QuizViewState | null): string | null {
  const current = matchingQuiz(source, state);
  const result = current?.result;
  const profile = result?.profile;
  return current?.status === 'complete' && !!current.quizId && !!current.requestId && result?.status === 'complete' &&
    profile?.profileId === source.profileId && profile.sourceApp === source.sourceApp && profile.revision !== source.revision ? profile.revision : null;
}

/** Host-driven setup conversation. No fixed questions or automatic live fallback. */
export function QuizPanel(props: QuizPanelProps) {
  const current = matchingQuiz(props.source, props.state);
  return <section aria-label="Learning preferences">
    <h2>Learning preferences</h2>
    <p>The LLM asks follow-up questions about how you work. Review its suggestions before using an updated profile.</p>
    {!props.available && <p role="status">Live quiz is currently unavailable. The separate preset learning demonstration does not run this quiz.</p>}
    <QuizConversation key={quizScopeKey(props.source, current, props.resetKey)} {...props} state={current} />
  </section>;
}

function QuizConversation({ source, state = null, available = false, disabled = false, onStart, onAnswer, onCancel, onAccept }: QuizPanelProps) {
  const [draft, setDraft] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const alive = useRef(true);
  const actionVersion = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // A successful command remains pending until a fresh host request/state arrives.
  // This prevents a second answer to the same question during IPC acknowledgement.
  async function act(callback: () => Action, cancel = false) {
    if (cancel ? cancelInFlight.current : inFlight.current) return;
    if (cancel) { cancelInFlight.current = true; setCancelling(true); }
    else { inFlight.current = true; setWaiting(true); }
    const version = ++actionVersion.current;
    setError(null);
    try { await callback(); if (alive.current && version === actionVersion.current) setDraft(''); }
    catch {
      if (!alive.current || version !== actionVersion.current) return;
      if (cancel) { cancelInFlight.current = false; setCancelling(false); }
      else { inFlight.current = false; setWaiting(false); }
      setError(cancel ? 'The quiz could not be cancelled. Try again.' : 'The quiz request was not accepted. Try again.');
    }
  }
  const interactive = available && !disabled;
  const status = state?.status ?? 'idle';
  const canStart = interactive && !!onStart && !waiting && !cancelling && ['idle', 'cancelled', 'error'].includes(status);
  const canCancel = !disabled && !!onCancel && !!state?.quizId && !cancelling && ['running', 'question', 'complete', 'error'].includes(status);
  const answer = quizAnswer(source, state, draft);
  const revision = quizAcceptedRevision(source, state);
  const canAnswer = interactive && !!onAnswer && !!answer && !waiting && !cancelling;
  const canAccept = interactive && !!onAccept && !!revision && !waiting && !cancelling;
  return <>
    <p>Source profile: {source.label}. Source evidence: {source.provenance.mode} ({source.provenance.provider}).</p>
    {state?.turns.length ? <ol aria-label="Quiz conversation">{state.turns.map(turn => <li key={turn.turnId}>
      <strong>{turn.role === 'assistant' ? 'Lucienne' : 'You'}:</strong> {turn.text}
    </li>)}</ol> : null}
    {state?.result && <p>Quiz response: {state.result.provenance.mode} ({state.result.provenance.provider}). Source evidence remains {source.provenance.mode}.</p>}
    {status === 'running' && <p role="status">Preparing the next quiz response…</p>}
    {status === 'question' && state?.result?.status === 'continue' && <form onSubmit={event => {
      event.preventDefault();
      if (canAnswer && answer && onAnswer) void act(() => onAnswer(answer));
    }}>
      <label htmlFor="quiz-answer">{state.result.question}</label>
      <textarea id="quiz-answer" value={draft} maxLength={2000} disabled={!interactive || waiting || cancelling || !onAnswer}
        onChange={event => setDraft(event.target.value)} />
      <button type="submit" disabled={!canAnswer}>{waiting ? 'Waiting for the next response…' : 'Send answer'}</button>
    </form>}
    {status === 'complete' && state?.result?.profile && <div>
      <h3>Review the profile suggestions</h3>
      <p>Inferred preferences are suggestions. Accepting this profile does not turn them into explicit instructions or start translation.</p>
      <dl>{state.result.profile.preferences.map(preference => <div key={preference.key}>
        <dt>{preference.key} · {preference.origin === 'explicit' ? 'Explicit instruction' : 'Inferred suggestion'}</dt>
        <dd>{preference.value}</dd>
      </div>)}</dl>
      <p>Source bindings stay attached to the profile: {Object.entries(state.result.profile.bindings).map(([key, value]) => `${key}: ${value}`).join('; ') || 'none supplied'}.</p>
      <button type="button" disabled={!canAccept} onClick={() => {
        if (canAccept && revision && state && onAccept) void act(() => onAccept({ ...identity(state), resultRevision: revision }));
      }}>Use reviewed profile</button>
    </div>}
    {status === 'cancelled' && <p role="status">Quiz cancelled. No suggested profile has been selected.</p>}
    {status === 'error' && <p role="alert">The quiz could not continue{state?.errorCode ? ` (${state.errorCode})` : ''}.</p>}
    {error && <p role="alert">{error}</p>}
    {['idle', 'cancelled', 'error'].includes(status) && <button type="button" disabled={!canStart} onClick={() => {
      if (canStart && onStart) void act(() => onStart({ sourceProfileId: source.profileId, sourceRevision: source.revision }));
    }}>{waiting ? 'Starting quiz…' : 'Start LLM quiz'}</button>}
    {canCancel && <button type="button" onClick={() => {
      if (state && onCancel) void act(() => onCancel(identity(state)), true);
    }}>Cancel quiz</button>}
    {cancelling && <p role="status">Cancelling quiz…</p>}
  </>;
}
