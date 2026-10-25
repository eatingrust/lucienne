import { useEffect, useRef, useState } from 'react';
import type { Command, DesktopBridge } from '../../../contracts/bridge.js';
import { ROUTES, SourceProfileSchema, type SourceProfile, type TargetApp } from '../../../contracts/index.js';
import fixtureProfile from '../../../contracts/examples/profile.json' with { type: 'json' };
import { getPresetLearningDemo } from '../../../profiles/learning-demo.js';
import { useRuntime } from './runtime.js';
import { canReset, chatPrompts, errorMessage, initialSelection, labels, profiles, runtimeError, seconds, sessionStatus } from './model.js';
import { activeCase, caseForChoice, catalogCases, chatChoices, disclosureForCase, selectionCommand } from './catalog.js';
import { OperatorApp } from './operator.js';
import { ClosingDialog } from './closing.js';
import { CommittedLimitations } from './committed.js';
import { QuizPanel } from './quiz.js';
import { PreparationPanel } from './preparation.js';
import { WorkflowPicker, type WorkflowStep } from './workflow-picker.js';
import { SourceBeforeThumbnail, ToolMappingDisclosure, type ResolvedSourceThumbnail, type WorkflowDisclosure } from './disclosures.js';

const preset = getPresetLearningDemo();
const syntheticProfile = SourceProfileSchema.parse(fixtureProfile);
function ProfileDetails({ profile }: { profile: SourceProfile }) {
  return <section aria-label="Profile details">
    <p><strong>Source profile: {profile.provenance.mode}</strong> · {profile.label}</p>
    <p>{profile.provenance.mode === 'simulated' ? 'This demonstration persona represents a scripted workflow, not your observed usage.' : 'Preferences and source bindings come from this profile.'}</p>
    <details><summary>Source bindings and preferences</summary>
      <ul>{Object.entries(profile.bindings).map(([action, binding]) => <li key={action}>{action}: <kbd>{binding.replace('Meta+', '⌘')}</kbd></li>)}</ul>
      <ul>{profile.preferences.map(preference => <li key={preference.key}>{preference.key}: {preference.value} <small>({preference.origin})</small></li>)}</ul>
    </details>
  </section>;
}

// Optional host-owned presentation data. No invented bridge fields or asset fallback.
export function App({ bridge, sourceThumbnail, workflowDisclosure }: { bridge?: DesktopBridge; sourceThumbnail?: ResolvedSourceThumbnail | null; workflowDisclosure?: WorkflowDisclosure | null }) {
  const { runtime, error, pending, send, reconnect } = useRuntime(bridge);
  const [selection, setSelection] = useState(initialSelection);
  const [pickerStep, setPickerStep] = useState<WorkflowStep>('source');
  const [destinationChosen, setDestinationChosen] = useState(false);
  const [operator, setOperator] = useState(false);
  const [showPreset, setShowPreset] = useState(false);
  const previousPhase = useRef(runtime?.snapshot.phase);
  const phase = runtime?.snapshot.phase ?? 'idle';
  const sendQuiz = async (command: Command) => {
    if (!await send(command)) throw new Error('Quiz command was not accepted');
  };
  const resetWorkflow = async () => {
    if (await send({ type: 'reset' })) {
      setSelection(initialSelection); setPickerStep('source'); setDestinationChosen(false); setShowPreset(false); setOperator(false);
    }
  };
  useEffect(() => {
    if (previousPhase.current && previousPhase.current !== 'idle' && phase === 'idle') {
      setSelection(initialSelection); setPickerStep('source'); setDestinationChosen(false); setShowPreset(false); setOperator(false);
    }
    previousPhase.current = phase;
  }, [phase]);
  if (runtime?.qa.enabled || operator) return <>
    {!runtime?.qa.enabled && <nav><button onClick={() => setOperator(false)}>Return to workflow</button></nav>}
    <OperatorApp />
  </>;
  const fixture = !!runtime?.fixtureEnabled;
  const offeredProfiles = runtime?.catalog?.profiles ?? profiles;
  const cases = catalogCases(runtime);
  const draftProfile = offeredProfiles.find(item => item.profileId === selection.profileId) ?? offeredProfiles[0];
  const targetsFor = (sourceProfile: SourceProfile | undefined): TargetApp[] => sourceProfile ? runtime?.catalog
    ? [...new Set(cases.filter(row => row.profileId === sourceProfile.profileId).map(row => row.targetApp))]
    : [...ROUTES[sourceProfile.sourceApp]] : [];
  const draftTargets = targetsFor(draftProfile);
  const draftTarget = draftTargets.includes(selection.targetApp) ? selection.targetApp : draftTargets[0];
  const selectedCase = activeCase(runtime);
  const draftCase = destinationChosen && draftProfile && draftTarget ? caseForChoice(runtime, draftProfile.profileId, draftTarget) : null;
  const row = phase === 'idle' ? draftCase : selectedCase;
  const profile = fixture ? syntheticProfile : row?.source ?? (phase === 'idle' ? draftProfile : undefined);
  const targetApp = row?.targetApp ?? (phase === 'idle' && destinationChosen ? draftTarget : undefined);
  const destinations = targetsFor(profile);
  const busy = !!pending || !!runtime?.snapshot.busy || !!runtime?.qa.running;
  const preparation = runtime?.services?.preparation;
  const recovery = !!runtime?.quiz?.recoveryRequired || !!preparation?.recoveryRequired || preparation?.status === 'recovery-required';
  const quizState = runtime?.quiz?.state;
  const activeQuiz = !!quizState && ['running', 'question', 'complete', 'error'].includes(quizState.status);
  const quizSource = activeQuiz ? offeredProfiles.find(item => item.profileId === quizState.sourceProfileId && item.revision === quizState.sourceRevision) :
    pickerStep === 'destination' && destinationChosen ? profile : undefined;
  const locked = phase !== 'idle' || busy || activeQuiz || recovery || !!preparation?.busy;
  // A pending start/answer still allows cancelling the current host-issued request.
  const quizDisabled = phase !== 'idle' || !!runtime?.snapshot.busy || recovery ||
    (!!pending && !['quiz-start', 'quiz-answer'].includes(pending)) || (!!preparation?.busy && !activeQuiz);
  const contextBlocksTranslation = recovery || !!preparation?.busy || preparation?.context.status === 'preparing' || preparation?.context.status === 'failed';
  const select = row ? selectionCommand(runtime, row, pending) : null;
  const unavailable = !runtime ? 'Connect to the desktop runtime to translate.' : !runtime.catalog ? 'The workflow catalog has not been connected to this runtime.' :
    !row ? 'Matching workflow metadata is unavailable.' : !row.selectable ? row.reason ?? 'This case is unavailable in this runtime.' :
      !runtime.nativeAdapterAvailable ? 'Native translation is unavailable. Ask the operator to complete runtime setup.' :
        !row.initialModes.includes(runtime.nativePrepared ? 'prepared' : 'live') ? 'This runtime’s planning mode is unavailable for this case.' : null;
  const projectedDisclosure = row ? disclosureForCase(row) : null;
  const scope = row ? { scenarioId: row.scenarioId, target: row.target, profile: row.source } : fixture && runtime?.snapshot.scenarioId && runtime.snapshot.target
    ? { scenarioId: runtime.snapshot.scenarioId, target: runtime.snapshot.target, profile: syntheticProfile } : null;
  const adjustments = fixture ? chatPrompts.map(prompt => ({ intent: prompt.intent, label: prompt.text, instruction: '' })) : chatChoices(runtime);
  const chatEnabled = !!runtime?.chatAvailable && adjustments.length > 0;
  const planner = selectedCase ? runtime?.selection?.planner : undefined;
  const status = runtime ? sessionStatus(runtime) : { title: 'Desktop runtime disconnected', detail: 'Open Lucienne on the demo Mac to select and translate a workflow.' };
  const reportedError = runtimeError(runtime, error);
  const nativeReady = phase === 'ready' && runtime?.snapshot.evidenceKind === 'native';
  const explorationVisible = ['ready', 'chat'].includes(phase);
  const showWorkflowDetails = fixture || phase !== 'idle' || (pickerStep === 'destination' && destinationChosen);
  return <main>
    <header className="row">
      <div><p>Lucienne</p><h1>Make the next workspace familiar</h1></div>
      <button className="operator-link" disabled={locked} onClick={() => setOperator(true)}>Operator view</button>
    </header>
    <p className="development-note">Functional preview · Visual design pending approval</p>
    <section className="panel" aria-labelledby="workflow-heading">
      <h2 id="workflow-heading">Your workflow</h2>
      {fixture ? <p role="status"><strong>Simulated fixture runtime.</strong> This exercises a synthetic contract example. No native app or desktop changes occur.</p> : <>
        <WorkflowPicker step={phase === 'idle' ? pickerStep : 'destination'} profiles={offeredProfiles} cases={cases}
          profile={profile} sourceApp={profile?.sourceApp} targetApp={targetApp} targets={destinations} locked={locked}
          onSource={source => {
            const nextProfile = offeredProfiles.find(item => item.sourceApp === source);
            if (!nextProfile) return;
            const nextTargets = targetsFor(nextProfile);
            setSelection({ profileId: nextProfile.profileId, targetApp: nextTargets.includes(selection.targetApp) ? selection.targetApp : nextTargets[0] ?? selection.targetApp });
            setDestinationChosen(false); setPickerStep('workspace');
          }}
          onWorkspace={profileId => { setSelection({ ...selection, profileId }); setDestinationChosen(false); setPickerStep('destination'); }}
          onTarget={target => { if (profile) { setSelection({ profileId: profile.profileId, targetApp: target }); setDestinationChosen(true); } }}
          onBack={setPickerStep} />
        <p>18 planned routes · 54 persona cases. {runtime?.catalog ? `${runtime.catalog.cases.length} cases supplied by this runtime.` : 'Available selections depend on this runtime.'}</p>
        {showWorkflowDetails && unavailable && <p role="status">{unavailable}</p>}
        {showWorkflowDetails && phase === 'idle' && row?.selectable && <p>Configured for selection. Native preflight and readback are still required.</p>}
        {showWorkflowDetails && phase === 'idle' && row && <p>Supported initial planning: {row.initialModes.length ? row.initialModes.join(', ') : 'unavailable'}.</p>}
        {showWorkflowDetails && profile && runtime?.catalog && <details><summary>Availability for this persona</summary><ul>
          {cases.filter(item => item.profileId === profile.profileId).map(item => <li key={item.scenarioId}>
            <strong>{labels[item.targetApp]}</strong>: {item.selectable ? 'Configured; native checks pending.' : item.reason ?? 'Unavailable in this runtime.'}
          </li>)}
        </ul></details>}
      </>}
      {showWorkflowDetails && <>{profile ? <><SourceBeforeThumbnail profile={profile} asset={sourceThumbnail} metadata={row?.sourceThumbnail} />
        <ProfileDetails profile={profile} /></> : <p role="status">Selected workflow details are pending. Reset to choose another workflow.</p>}
      <ToolMappingDisclosure disclosure={runtime?.catalog ? projectedDisclosure : workflowDisclosure} scope={scope} />
      <div className="controls">
        <button disabled={!runtime || locked || (!fixture && !select)} onClick={() => { if (fixture) void send({ type: 'select-fixture' }); else if (select) void send(select); }}>
          {fixture ? 'Select synthetic fixture' : 'Use this selection'}
        </button>
        <button disabled={!runtime || phase !== 'selected' || busy || contextBlocksTranslation || (!fixture && !selectedCase)} onClick={() => void send({ type: 'translate' })}>
          {fixture ? 'Run simulated translation' : 'Translate workspace'}
        </button>
      </div>
      </>}
    </section>

    <section className="panel" aria-labelledby="session-heading" aria-busy={!!runtime?.snapshot.busy}>
      <h2 id="session-heading">{status.title}</h2>
      <p role="status" aria-live="polite">{pending === 'select-scenario' && phase === 'idle' ? 'Checking this workflow and the desktop before confirming selection.' : status.detail}</p>
      {runtime && <p className="provenance">
        Latest planning: <strong>{fixture ? 'simulated fixture' : planner ? `${planner.mode} · ${planner.provider}` : 'not selected'}</strong>
        {' · '}Chat: <strong>{fixture ? 'simulated fixture' : chatEnabled ? 'available' : 'unavailable'}</strong>
        {' · '}Execution mode: <strong>{runtime.snapshot.evidenceKind}</strong>
      </p>}
      <CommittedLimitations snapshot={runtime?.snapshot} />
      {explorationVisible && <p className="countdown" role="timer" aria-live="off">{seconds(runtime!.snapshot.remainingMs)} seconds remaining{phase === 'chat' ? ' · Paused for chat' : ''}</p>}
      {(pending === 'select-scenario' || phase === 'planning' || phase === 'applying' || (phase === 'chat' && runtime?.snapshot.busy)) && <progress aria-label={pending === 'select-scenario' ? 'Checking selection' : status.title} />}
      <div className="controls">
        <button disabled={phase !== 'ready' || busy || !chatEnabled || (!nativeReady && !fixture)} onClick={() => void send({ type: 'open-chat' })}>Adjust workspace</button>
        <button disabled={!canReset(runtime, pending)} onClick={() => void resetWorkflow()}>{fixture ? 'Reset simulation' : pending === 'select-scenario' ? 'Cancel selection' : ['planning', 'applying', 'chat'].includes(phase) && busy ? 'Cancel and reset' : 'Reset to desktop'}</button>
      </div>
      {phase === 'ready' && !chatEnabled && <p>Workspace adjustments are unavailable for this selection in the current runtime.</p>}
      {phase === 'chat' && <section aria-label="Supported workspace adjustments">
        <p>Choose a supported change. Each change is validated and read back before exploration resumes.</p>
        <div className="controls">{adjustments.map(prompt => <button key={prompt.intent} disabled={busy || !chatEnabled} onClick={() => void send({ type: 'chat', intent: prompt.intent })}>{prompt.label}</button>)}</div>
        {!adjustments.length && <p>Supported changes are pending matching workflow metadata.</p>}
        <button disabled={busy} onClick={() => void send({ type: 'close-chat' })}>Resume without a change</button>
      </section>}
      {reportedError && <div role="alert"><p>{errorMessage(reportedError)}</p><details><summary>Operator error code</summary><code>{reportedError}</code></details></div>}
      {error === 'BRIDGE_UNAVAILABLE' && <button onClick={() => void reconnect()}>Reconnect</button>}
      {!bridge && <p>Browser preview only. Translation controls require the desktop bridge.</p>}
    </section>

    {phase === 'closing' && <ClosingDialog remainingMs={runtime!.snapshot.closingRemainingMs} disabled={!canReset(runtime, pending)} onReset={() => void resetWorkflow()} />}
    {phase === 'idle' && !fixture && activeQuiz && !quizSource && <p role="alert">The quiz does not match the current source catalog. Reset to desktop before continuing.</p>}
    {phase === 'idle' && !fixture && quizSource && <section className="panel" aria-label="Profile preparation">
      {recovery && <p role="alert">The quiz needs recovery. Use Reset to desktop before continuing.</p>}
      <QuizPanel source={quizSource} state={quizState} available={!!runtime?.quiz?.available && !recovery}
        disabled={quizDisabled} resetKey={runtime?.quiz?.resetKey}
        onStart={input => sendQuiz({ type: 'quiz-start', ...input })}
        onAnswer={input => sendQuiz({ type: 'quiz-answer', ...input })}
        onCancel={input => sendQuiz({ type: 'quiz-cancel', ...input })}
        onAccept={input => sendQuiz({ type: 'quiz-accept', ...input })} />
      <details open={showPreset} onToggle={event => setShowPreset(event.currentTarget.open)}>
        <summary>Inspect the separate preset learning demonstration</summary>
        <p><strong>{preset.label}</strong></p>
        <ul>{preset.takeaways.map(item => <li key={item}>{item}</li>)}</ul>
        <p>This predetermined example is separate from the LLM quiz and live translation. It is never applied to the selected workflow.</p>
        <ProfileDetails profile={preset.result} />
      </details>
    </section>}
    {!fixture && <PreparationPanel key={runtime?.quiz?.resetKey ?? runtime?.snapshot.runId ?? 'unselected'} runtime={runtime} pending={pending} onCommand={send} />}
  </main>;
}
