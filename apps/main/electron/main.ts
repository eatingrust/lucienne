import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CommandSchema, type RuntimeState } from '../../../contracts/bridge.js';
import { validateRequest, type RunEvent, type SourceProfile } from '../../../contracts/index.js';
import { SessionCoordinator, type Selection } from '../../../core/session.js';
import { makeFixture } from '../../../core/fixture.js';
import example from '../../../contracts/examples/planner-request.json' with { type: 'json' };
import fixturePatch from '../../../contracts/examples/patch.json' with { type: 'json' };
import type { NativeAdapter, PlannerPort } from '../../../contracts/ports.js';
import { loadProfiles } from '../../../profiles/index.js';
import { TelemetryQueue, createTigerSink, type TigerSink } from '../../../services/telemetry/src/index.js';
import { nativeSecrets } from './native-config.js';
import { assertDedicatedConsole, createNativeDesktop } from './native-desktop.js';
import { NativeQAController, OrdinaryRelaunchObligation } from './native-qa.js';
import { createNativeQAAttempt, nativeQACatalog, nativeQASelectionAvailable, prepareDefaultNativeQA,
  prepareNativeQAScenario, supportsNativeQA } from './native-qa-routing.js';
import type { EvidenceArtifact } from '../../../qa/artifacts.js';
import { createNativeAdapterRegistry, ScenarioSelectionGate,
  type NativeAdapterRegistry, type RegisteredNativeScenario } from './adapter-registry.js';
import { HostServices } from './host-services.js';
import { CompanionPairingHandoff, pairingRequested } from './pairing-handoff.js';

const smoke = process.argv.includes('--smoke-test');
const fixtureEnabled = process.argv.includes('--fixture') || smoke;
const qaEnabled = process.argv.includes('--native-qa') && !fixtureEnabled;
const nativeEnabled = (process.argv.includes('--krita') || process.argv.includes('--native') || qaEnabled) && !fixtureEnabled;
const nativePrepared = nativeEnabled && process.argv.includes('--prepared');
app.setName('Lucienne Integration');
const ownsSession = app.requestSingleInstanceLock();
if (!ownsSession) app.exit(smoke ? 2 : 0);
const fixture = makeFixture(validateRequest(example));
const curatedProfiles = loadProfiles();
let window: BrowserWindow | null = null;
let fixtureInitialPlanner: PlannerPort;
let nativeAdapter: NativeAdapter | undefined;
let nativeSelection: Selection | undefined;
let initialPlanner: PlannerPort | undefined;
let liveInitialPlanner: PlannerPort | undefined;
let preparedPlannerFor: ((scenario: RegisteredNativeScenario) => PlannerPort) | undefined;
let nativeRegistry: NativeAdapterRegistry | undefined;
let rebuildNativeRegistry: ((profiles: SourceProfile[]) => NativeAdapterRegistry) | undefined;
let selectedScenario: RegisteredNativeScenario | undefined;
const selectionGate = new ScenarioSelectionGate();
let selectionInProgress = false;
let qaStarting = false;
let chatPlanner: PlannerPort | undefined;
let nativeStartupError: string | null = null;
let nativeSetupReady = false;
let chatAvailable = fixtureEnabled;
let telemetry: TelemetryQueue | undefined;
let tiger: TigerSink | undefined;
let hostServices: HostServices | undefined;
let pairingHandoff: CompanionPairingHandoff | undefined;
let pairingQueued = pairingRequested(process.argv);
let exiting = false;
const ordinaryRelaunch = new OrdinaryRelaunchObligation();
let exitAttempt: Promise<void> | undefined;
let buildId = 'unbuilt';
let activeRunId = '';
let lifecycleGeneration = 0;
let observedPlanner: { runId: string; mode: PlannerPort['mode']; provider: string } | undefined;
function requestCompanionPairing(): void {
  if (fixtureEnabled || !ownsSession) { console.error('PAIRING_ACCOUNT_REQUIRED'); return; }
  if (exiting || exitAttempt) { console.error('PAIRING_HANDOFF_CANCELLED'); return; }
  if (!pairingHandoff) { pairingQueued = true; return; }
  pairingQueued = false;
  // The exporter returns a finite status code only. Capabilities never reach logs or IPC.
  void pairingHandoff.request().then(status => { console.log(status); });
}
let desktopBlockers: NonNullable<RuntimeState['desktopBlockers']> = [];
const hostArtifacts: EvidenceArtifact[] = [];
const evidenceDirectory = () => path.join(app.getPath('userData'), 'evidence');
const publishState = () => { if (window && !window.isDestroyed()) window.webContents.send('lucienne:state-changed', runtimeState()); };
const showPreparationRecovery = () => {
  if (!smoke && (hostServices?.snapshot().preparation.recoveryRequired || hostServices?.quizSnapshot().recoveryRequired)
    && coordinator.snapshot().phase !== 'resetting') {
    app.show(); window?.show(); window?.focus();
  }
};
const qa = new NativeQAController(qaEnabled, publishState);
const trackEvent = (event: RunEvent) => {
  activeRunId = event.runId;
  if (event.provider !== 'none') observedPlanner = { runId: event.runId, mode: event.mode, provider: event.provider };
  hostServices?.trackEvent(event);
  telemetry?.event(event);
  if (event.type === 'reset-started' && nativeSelection && nativeSelection.source.revision !==
      curatedProfiles.find(profile => profile.profileId === nativeSelection!.source.profileId)?.revision) {
    // The coordinator retains its own adapter for recovery; release visitor-derived
    // profile/recipe references held by the host as soon as a real reset starts.
    nativeSelection = undefined; selectedScenario = undefined; initialPlanner = undefined; nativeAdapter = undefined;
  }
  if (event.type === 'reset-completed') showPreparationRecovery();
};
const desktop = fixtureEnabled ? fixture.desktop : createNativeDesktop({
    helperPath: path.join(__dirname, '../native/desktop-probe'), evidenceDirectory: evidenceDirectory(),
    hide: () => app.hide(), isHidden: () => app.isHidden(),
    showRecovery: () => { app.show(); window?.show(); window?.focus(); },
    identity: () => {
      if (!activeRunId || buildId === 'unbuilt') throw new Error('DESKTOP_IDENTITY_MISSING');
      return { buildId, runId: activeRunId };
    },
    onArtifact: artifact => { hostArtifacts.push(artifact); },
    onBlocked: blockers => { desktopBlockers = blockers; publishState(); },
});
let coordinator = new SessionCoordinator({ desktop, onEvent: trackEvent });
const runtimeState = (): RuntimeState => {
  const snapshot = coordinator.snapshot();
  const selection = fixtureEnabled ? fixture.selection : nativeSelection;
  const planner = fixtureEnabled ? fixtureInitialPlanner : initialPlanner;
  const nativeAdapterAvailable = qaEnabled
    ? nativeQASelectionAvailable(nativeSetupReady, nativeRegistry)
    : !!nativeRegistry && !!preparedPlannerFor && (nativePrepared || !!liveInitialPlanner);
  return { fixtureEnabled, nativeAdapterAvailable,
    nativePrepared, nativeStartupError, chatAvailable, snapshot, qa: structuredClone(qa.state),
    desktopBlockers: structuredClone(desktopBlockers),
    ...(hostServices ? { services: hostServices.snapshot() } : {}),
    ...(hostServices ? { quiz: hostServices.quizSnapshot() } : {}),
    ...(nativeRegistry ? { catalog: { profiles: hostServices?.profiles() ?? curatedProfiles,
      cases: qaEnabled ? nativeQACatalog(nativeRegistry.list()) : nativeRegistry.list() } } : {}),
    selection: (snapshot.runId || (qaEnabled && selectedScenario)) && selection && planner ? {
      scenarioId: selection.scenarioId, profileId: selection.source.profileId, profileRevision: selection.source.revision,
      sourceApp: selection.source.sourceApp, target: structuredClone(selection.target),
      planner: observedPlanner?.runId === snapshot.runId ? { mode: observedPlanner.mode, provider: observedPlanner.provider }
        : { mode: planner.mode, provider: planner.provider },
    } : null,
  };
};
async function checkDesktopBeforeRun(): Promise<void> {
  if (fixtureEnabled) return;
  if (!('checkBeforeRun' in desktop) || typeof desktop.checkBeforeRun !== 'function') throw new Error('DESKTOP_PROBE_UNAVAILABLE');
  await desktop.checkBeforeRun();
}
async function selectScenario(scenarioId: string): Promise<void> {
  if (selectionInProgress) throw new Error('RESET_REQUIRED');
  selectionInProgress = true;
  try {
  // This fixture registry exists only in the hidden IPC smoke; it never advertises native availability.
  if (smoke) {
    if (scenarioId !== fixture.selection.scenarioId) throw new Error('UNKNOWN_NATIVE_SCENARIO');
    await selectionGate.run({ isIdle: () => coordinator.snapshot().phase === 'idle' && !exitAttempt, guard: async () => {},
      prepare: async () => { await hostServices?.prepareSelection(); return fixture; },
      commit: item => { coordinator.select(item.selection, item.adapter); } });
    return;
  }
  if (fixtureEnabled || !nativeRegistry || !preparedPlannerFor || (!nativePrepared && !liveInitialPlanner)
    || (qaEnabled && !nativeSetupReady))
    throw new Error('NATIVE_ADAPTER_NOT_AVAILABLE');
  // Membership is checked before account checks or constructors; renderer provides only this finite ID.
  const row = nativeRegistry.list().find(item => item.scenarioId === scenarioId);
  if (!row) throw new Error('UNKNOWN_NATIVE_SCENARIO');
  if (!row.selectable) throw new Error('NATIVE_SCENARIO_UNAVAILABLE');
  if (qaEnabled && (!supportsNativeQA(row) || qa.state.stage !== 'not-started')) throw new Error('QA_SCENARIO_UNAVAILABLE');
  await selectionGate.run({
    isIdle: () => coordinator.snapshot().phase === 'idle' && !ordinaryRelaunch.pending && !qaStarting && !qa.state.running && !exiting && !exitAttempt,
    guard: assertDedicatedConsole,
    prepare: async assertCurrent => {
      await hostServices?.prepareSelection(); assertCurrent();
      await coordinator.reset(); assertCurrent();
      const plannerFor = (scenario: RegisteredNativeScenario) => nativePrepared ? preparedPlannerFor!(scenario) : liveInitialPlanner!;
      const prepared = qaEnabled ? await prepareNativeQAScenario(nativeRegistry!, scenarioId, plannerFor) : undefined;
      const next = prepared?.scenario ?? nativeRegistry!.create(scenarioId);
      if (!qaEnabled) await next.adapter.preflight?.();
      assertCurrent();
      await assertDedicatedConsole(); assertCurrent();
      return { next, planner: prepared?.planner ?? plannerFor(next) };
    },
    commit: ({ next, planner }) => {
      nativeAdapter = next.adapter; nativeSelection = next.selection;
      selectedScenario = next; initialPlanner = planner; nativeStartupError = null;
      // The QA runner creates its own run identity and owns coordinator.select.
      if (!qaEnabled) coordinator.select(next.selection, next.adapter);
    },
  });
  } finally { selectionInProgress = false; }
}
function requestExit(): Promise<void> {
  if (exitAttempt) return exitAttempt;
  selectionGate.invalidate(); lifecycleGeneration++;
  pairingQueued = false; pairingHandoff?.invalidate();
  exitAttempt = (async () => {
    await qa.cancelAndWait();
    if (ordinaryRelaunch.pending) {
      try { await ordinaryRelaunch.verifyClosed(); }
      catch {
        qa.state.result = `Close ordinary ${ordinaryRelaunch.targetLabel}, then close Lucienne again. Baseline verification is still required.`;
        publishState(); throw new Error('ORDINARY_RELAUNCH_RECOVERY_REQUIRED');
      }
    }
    if (hostServices) await hostServices.reset(() => coordinator.reset()); else await coordinator.reset();
    await hostServices?.close();
    const pairingStatus = await pairingHandoff?.close();
    if (pairingStatus === 'PAIRING_HANDOFF_CLEANUP_FAILED') console.error(pairingStatus);
    exiting = true; app.quit();
  })().catch(cause => { showPreparationRecovery(); throw cause; }).finally(() => { exitAttempt = undefined; });
  return exitAttempt;
}

async function createWindow(): Promise<void> {
  const entry = path.join(__dirname, '../renderer/index.html');
  const expectedURL = pathToFileURL(entry).href;
  window = new BrowserWindow({ width: 900, height: 680, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, spellcheck: false } });
  const win = window;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  const assertSender = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== expectedURL) throw new Error('UNTRUSTED_FRAME');
  };
  ipcMain.handle('lucienne:state', event => { assertSender(event); return runtimeState(); });
  ipcMain.handle('lucienne:command', async (event, raw: unknown) => {
    assertSender(event);
    try {
      const command = CommandSchema.parse(raw);
      if (exitAttempt && command.type !== 'reset') throw new Error('EXIT_IN_PROGRESS');
      if (!fixtureEnabled && !runtimeState().nativeAdapterAvailable && !command.type.startsWith('quiz-') &&
          !['reset', 'preparation-status', 'cancel-preparation'].includes(command.type))
        return { ok: false, code: nativeStartupError ?? 'NATIVE_ADAPTER_NOT_AVAILABLE' };
      if (qaEnabled && !['start-native-qa', 'complete-qa-step', 'select-scenario', 'select-krita', 'reset'].includes(command.type)) throw new Error('QA_ONE_ATTEMPT_MODE');
      if ((qa.state.running || qaStarting) && !['complete-qa-step', 'reset'].includes(command.type)) throw new Error('QA_OWNS_SESSION');
      switch (command.type) {
        case 'start-native-qa': {
          if (!qaEnabled || !selectedScenario || !supportsNativeQA(selectedScenario.selection) || !initialPlanner
            || !chatPlanner || !chatAvailable || qaStarting || selectionInProgress || ordinaryRelaunch.pending
            || coordinator.snapshot().phase !== 'idle' || qa.state.running || qa.state.stage !== 'not-started') throw new Error('QA_START_REJECTED');
          const scenario = selectedScenario, planner = initialPlanner;
          const generation = lifecycleGeneration;
          qaStarting = true;
          try {
            await checkDesktopBeforeRun();
            if (generation !== lifecycleGeneration || selectedScenario !== scenario || selectionInProgress
              || coordinator.snapshot().phase !== 'idle') throw new Error('QA_START_CANCELLED');
            const runId = `native-qa-${randomUUID()}`; activeRunId = runId;
            qa.start(createNativeQAAttempt({ scenario, buildId, runId,
              outputRoot: path.join(app.getPath('userData'), 'qa'), evidenceRoot: evidenceDirectory(),
              desktop, initialPlanner: planner, chatPlanner, ordinaryRelaunch,
              getHostArtifacts: () => hostArtifacts.filter(a => a.runId === runId),
              addHostArtifacts: artifacts => hostArtifacts.push(...artifacts), onSnapshot: publishState,
              waitForOperator: (instruction, signal) => qa.waitForOperator(instruction, signal),
              showOperator: () => { app.show(); window?.show(); window?.focus(); },
              createCoordinator: options => {
                coordinator = new SessionCoordinator({ ...options, onEvent: event => { trackEvent(event); options.onEvent(event); } });
                return coordinator;
              },
            }));
          } finally { qaStarting = false; }
          break;
        }
        case 'complete-qa-step': qa.complete(command.id); break;
        case 'select-fixture': {
          if (!fixtureEnabled) throw new Error('FIXTURE_NOT_ENABLED');
          if (selectionInProgress || coordinator.snapshot().phase !== 'idle' || exitAttempt || exiting) throw new Error('RESET_REQUIRED');
          selectionInProgress = true;
          const generation = lifecycleGeneration;
          try {
            await hostServices?.prepareSelection();
            if (generation !== lifecycleGeneration || coordinator.snapshot().phase !== 'idle' || exitAttempt || exiting)
              throw new Error('SCENARIO_SELECTION_CANCELLED');
            coordinator.select(fixture.selection, fixture.adapter);
          }
          finally { selectionInProgress = false; }
          break;
        }
        case 'select-krita': {
          await selectScenario('photoshop-collage-to-krita'); break;
        }
        case 'select-scenario': await selectScenario(command.scenarioId); break;
        case 'translate': {
          if (!fixtureEnabled && (!nativeAdapter || !nativeSelection || !initialPlanner)) throw new Error('NATIVE_SCENARIO_NOT_SELECTED');
          const generation = lifecycleGeneration;
          const runId = coordinator.snapshot().runId;
          const planner = fixtureEnabled ? fixtureInitialPlanner : initialPlanner!;
          await checkDesktopBeforeRun();
          if (generation !== lifecycleGeneration || coordinator.snapshot().runId !== runId) throw new Error('TRANSLATION_CANCELLED');
          await coordinator.translate(planner, hostServices ? (request, signal) => hostServices!.prepareInitialRequest(request, signal) : undefined); break;
        }
        case 'open-chat': coordinator.openChat(); break;
        case 'chat': {
          const changes = {
            'move-key-panels': { key: 'panel-side', value: 'right' },
            'enlarge-work-area': { key: 'work-area', value: 'large' },
            'simplify-tools': { key: 'tool-density', value: 'simple' },
          };
          const prompts = { 'move-key-panels': 'Move Layers to the right.', 'enlarge-work-area': 'Give the canvas more room.',
            'simplify-tools': 'Simplify the visible controls for this task.' };
          if (!chatAvailable) throw new Error('CLAUDE_AUTH_REQUIRED');
          const change = fixtureEnabled ? {
            intent: command.intent, instruction: prompts[command.intent], explicit: [changes[command.intent]],
          } : selectedScenario?.chat(command.intent, coordinator.committedOperations());
          if (!change) throw new Error('NATIVE_SCENARIO_NOT_SELECTED');
          await coordinator.chat(fixtureEnabled ? fixture.planner : chatPlanner!, change); break;
        }
        case 'close-chat': coordinator.closeChat(); break;
        case 'preparation-status': {
          if (!hostServices) throw new Error('PREPARATION_UNAVAILABLE');
          await hostServices.refreshPreparation(); break;
        }
        case 'prepare-context': {
          if (!hostServices) throw new Error('PREPARATION_UNAVAILABLE');
          if (coordinator.snapshot().phase !== 'selected') throw new Error('PREPARATION_SELECTION_REQUIRED');
          await hostServices.prepareContext(command.recipe, command.retrieval); break;
        }
        case 'cancel-preparation': {
          if (!hostServices) throw new Error('PREPARATION_UNAVAILABLE');
          await hostServices.cancelPreparation(); break;
        }
        case 'quiz-start': {
          if (!hostServices) throw new Error('QUIZ_PROVIDER_DISABLED');
          const { type: _type, ...input } = command; await hostServices.startQuiz(input); break;
        }
        case 'quiz-answer': {
          if (!hostServices) throw new Error('QUIZ_PROVIDER_DISABLED');
          const { type: _type, ...input } = command; await hostServices.answerQuiz(input); break;
        }
        case 'quiz-cancel': {
          if (!hostServices) throw new Error('QUIZ_PROVIDER_DISABLED');
          const { type: _type, ...input } = command; await hostServices.cancelQuiz(input); break;
        }
        case 'quiz-accept': {
          if (!hostServices) throw new Error('QUIZ_PROVIDER_DISABLED');
          const { type: _type, ...input } = command; await hostServices.acceptQuiz(input); break;
        }
        case 'reset': {
          selectionGate.invalidate(); lifecycleGeneration++;
          if (qa.state.running) {
            qa.abort(); await hostServices?.resetPreparation();
          } else if (hostServices) await hostServices.reset(() => coordinator.reset());
          else await coordinator.reset();
          break;
        }
      }
      return { ok: true };
    } catch (cause) {
      showPreparationRecovery();
      const message = cause instanceof Error ? cause.message : '';
      return { ok: false, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(message) ? message : 'COMMAND_REJECTED' };
    }
  });
  const unsubscribe = coordinator.subscribe(() => {
    if (!win.isDestroyed()) win.webContents.send('lucienne:state-changed', runtimeState());
  });
  win.on('close', event => {
    if (exiting) return;
    event.preventDefault();
    void requestExit().catch(() => { /* Keep recovery visible. */ });
  });
  win.on('closed', () => { unsubscribe(); ipcMain.removeHandler('lucienne:state'); ipcMain.removeHandler('lucienne:command'); window = null; });
  await win.loadFile(entry);
  if (!smoke) win.show();
  if (smoke) {
    // Hidden window only: verifies the actual preload/renderer IPC seam without owning the desktop.
    const result = await win.webContents.executeJavaScript(`(async () => {
      const bridge = window.lucienne;
      if (!bridge) throw new Error('Missing preload bridge');
      let updates = 0;
      const unsubscribe = bridge.subscribe(() => updates++);
      for (const command of [{type:'preparation-status'}, {type:'select-fixture'}, {type:'translate'}, {type:'open-chat'},
        {type:'chat', intent:'enlarge-work-area'}, {type:'reset'}]) {
        const result = await bridge.command(command);
        if (!result.ok) throw new Error(result.code);
      }
      const state = await bridge.getState();
      if (state.snapshot.phase !== 'idle' || state.snapshot.runId !== null || !updates) throw new Error('Lifecycle smoke failed');
      if (state.services?.session.status !== 'disabled' || state.services?.preparation.mode !== 'local' ||
          state.services?.preparation.context.status !== 'none') throw new Error('Fixture service isolation failed');
      if (state.quiz?.available || state.quiz?.state !== null) throw new Error('Fixture quiz isolation failed');
      const disabledQuiz = await bridge.command({type:'quiz-start', sourceProfileId:'photoshop-collage', sourceRevision:'1'});
      if (disabledQuiz.ok || disabledQuiz.code !== 'QUIZ_PROVIDER_DISABLED') throw new Error('Fixture started a quiz provider');
      for (const command of [
        {type:'execute-shell', command:'invalid'},
        {type:'select-scenario', scenarioId:'unknown-case'},
        {type:'select-scenario', scenarioId:'../injected'},
        {type:'select-scenario', scenarioId:${JSON.stringify(fixture.selection.scenarioId)}, nativeDirectory:'/private/injected'},
        {type:'select-scenario', scenarioId:${JSON.stringify(fixture.selection.scenarioId)}, bindingApplicability:{}},
        {type:'prepare-context', recipe:'persona', retrieval:'local-curated', source:{}},
        {type:'prepare-context', recipe:'persona', retrieval:'moss', endpoint:'https://injected.invalid'},
        {type:'cancel-preparation', jobId:'injected'},
        {type:'quiz-start', sourceProfileId:'photoshop-collage', sourceRevision:'1', profile:{}},
        {type:'quiz-start', sourceProfileId:'photoshop-collage', sourceRevision:'1', model:'injected'},
      ]) {
        const rejected = await bridge.command(command);
        if (rejected.ok) throw new Error('Unbounded scenario IPC command accepted');
      }
      const selected = await bridge.command({type:'select-scenario', scenarioId:${JSON.stringify(fixture.selection.scenarioId)}});
      if (!selected.ok) throw new Error(selected.code);
      const selectedState = await bridge.getState();
      if (selectedState.selection?.scenarioId !== ${JSON.stringify(fixture.selection.scenarioId)} ||
          selectedState.snapshot.evidenceKind !== 'fixture' || selectedState.nativeAdapterAvailable) throw new Error('Generic fixture identity failed');
      const reselected = await bridge.command({type:'select-scenario', scenarioId:${JSON.stringify(fixture.selection.scenarioId)}});
      if (reselected.ok || reselected.code !== 'RESET_REQUIRED') throw new Error('Active case replacement accepted');
      for (const command of [{type:'translate'}, {type:'open-chat'}, {type:'chat',intent:'move-key-panels'}, {type:'reset'}]) {
        const result = await bridge.command(command); if (!result.ok) throw new Error(result.code);
      }
      const final = await bridge.getState(); unsubscribe();
      if (final.snapshot.phase !== 'idle' || final.selection !== null) throw new Error('Generic fixture reset failed');
      return {phase:final.snapshot.phase, updates, nodeExposed:typeof window.require !== 'undefined', fixtureOnly:true, genericSelection:true};
    })()`);
    if (result.nodeExposed) throw new Error('Renderer Node access exposed');
    console.log(JSON.stringify({ smoke: 'passed', ...result, initialPlanner: fixtureInitialPlanner.provider }));
    await hostServices?.close();
    exiting = true; app.quit();
  }
}
app.on('second-instance', (_event, argv) => {
  if (pairingRequested(argv)) { requestCompanionPairing(); return; }
  if (!smoke) { window?.show(); window?.focus(); }
});
app.on('activate', () => {
  if (!smoke && coordinator.snapshot().phase !== 'resetting') { app.show(); window?.show(); window?.focus(); }
});
if (ownsSession) app.whenReady().then(async () => {
  if (smoke) app.dock?.hide();
  if (pairingQueued && !fixtureEnabled) {
    try {
      await assertDedicatedConsole();
      if (process.getuid?.() !== 502 || process.geteuid?.() !== 502) throw new Error('PAIRING_ACCOUNT_REQUIRED');
    } catch {
      console.error('PAIRING_ACCOUNT_REQUIRED'); exiting = true; app.exit(1); return;
    }
  }
  // Trusted built ESM sidecar; never loaded from a renderer-supplied URL/path.
  const plannerModule: typeof import('../../../services/planner/src/index.js') = await import(
    pathToFileURL(path.join(__dirname, '../services/planner/src/index.js')).href
  );
  fixtureInitialPlanner = plannerModule.createPreparedPlanner(() => ({
    operations: fixturePatch.operations, evidenceRefs: fixturePatch.evidenceRefs,
  }));
  hostServices = new HostServices({ userData: app.getPath('userData'), fixture: fixtureEnabled,
    preparationDirectory: path.join(__dirname, '../services/preparation'), onStatus: () => { publishState(); showPreparationRecovery(); },
    isSessionActive: () => coordinator.snapshot().phase !== 'idle' || selectionInProgress || qaEnabled ||
      qa.state.running || ordinaryRelaunch.pending || exiting || !!exitAttempt,
    onAcceptedProfiles: profiles => {
      if (!rebuildNativeRegistry) return;
      try { nativeRegistry = rebuildNativeRegistry(profiles); }
      catch (cause) { nativeRegistry = undefined; throw cause; }
    },
    selected: () => {
      const runId = coordinator.snapshot().runId;
      const selection = fixtureEnabled ? fixture.selection : nativeSelection;
      return runId && selection ? { runId, selection: structuredClone(selection) } : undefined;
    } });
  let preparationClaude: { apiKey?: string; workspaceId?: string } = {};
  if (nativeEnabled) {
    try {
      await assertDedicatedConsole();
      const secrets = await nativeSecrets(app.getPath('userData'));
      preparationClaude = { apiKey: secrets.claudeApiKey, workspaceId: secrets.claudeWorkspaceId };
      const [adapterModule, blenderModule, reaperModule]: [typeof import('../../../adapters/krita/index.js'),
        typeof import('../../../adapters/blender/index.js'), typeof import('../../../adapters/reaper/index.js')] = await Promise.all([
        import(pathToFileURL(path.join(__dirname, '../adapters/krita/index.js')).href),
        import(pathToFileURL(path.join(__dirname, '../adapters/blender/index.js')).href),
        import(pathToFileURL(path.join(__dirname, '../adapters/reaper/index.js')).href),
      ]);
      const build = JSON.parse(await readFile(path.join(__dirname, '../build.json'), 'utf8')) as { buildId: string };
      buildId = build.buildId;
      rebuildNativeRegistry = profiles => createNativeAdapterRegistry({ buildId, evidenceRoot: evidenceDirectory(), assets: {
        krita: { pluginDirectory: path.join(__dirname, '../adapters/krita/plugin') },
        blender: { nativeDirectory: path.join(__dirname, '../adapters/blender/native'),
          windowProbePath: path.join(__dirname, '../native/blender-window-probe') },
        reaper: { nativeDirectory: path.join(__dirname, '../adapters/reaper/native'),
          probeExecutable: path.join(__dirname, '../native/reaper-readiness') },
      } }, { krita: adapterModule.createKritaAdapter, blender: blenderModule.createBlenderAdapter,
        reaper: reaperModule.createReaperAdapter }, profiles);
      nativeRegistry = rebuildNativeRegistry(hostServices.acceptedQuizProfiles());
      const factoryBinary = secrets.factoryBinary ?? path.join(process.resourcesPath, 'vendor/droid');
      if (!nativePrepared) {
        if (!secrets.factoryApiKey) throw new Error('FACTORY_CONFIG_REQUIRED');
        try { await access(factoryBinary, constants.X_OK); } catch { throw new Error('FACTORY_CONFIG_REQUIRED'); }
      }
      preparedPlannerFor = scenario => plannerModule.createPreparedPlanner(scenario.resolvePreparedRecipe);
      if (!nativePrepared) liveInitialPlanner = plannerModule.createManagedFactoryPlanner({
        binary: factoryBinary, apiKey: secrets.factoryApiKey, modelId: 'claude-opus-5-5' });
      chatPlanner = plannerModule.createDirectClaudeChatPlanner({ apiKey: secrets.claudeApiKey, workspaceId: secrets.claudeWorkspaceId, modelId: 'claude-opus-5-5' });
      chatAvailable = !!secrets.claudeApiKey;
      nativeSetupReady = true;
      // Krita stays the QA default, but its preflight does not disable Blender's
      // independent selection path. No failed default is published as selected.
      if (qaEnabled) {
        const first = await prepareDefaultNativeQA(nativeRegistry,
          scenario => nativePrepared ? preparedPlannerFor!(scenario) : liveInitialPlanner!);
        if (first.status === 'ready') {
          nativeAdapter = first.scenario.adapter; nativeSelection = first.scenario.selection;
          selectedScenario = first.scenario; initialPlanner = first.planner;
        } else nativeStartupError = first.code;
      } else if (process.argv.includes('--krita')) {
        const first = nativeRegistry.create('photoshop-collage-to-krita');
        await first.adapter.preflight?.();
        nativeAdapter = first.adapter; nativeSelection = first.selection; selectedScenario = first;
        initialPlanner = nativePrepared ? preparedPlannerFor(first) : liveInitialPlanner;
      }
      // Optional diagnostics never gate local ready/reset; no connection until scheduled flush.
      if (secrets.tigerDatabaseURL) {
        try { tiger = await createTigerSink(secrets.tigerDatabaseURL); telemetry = new TelemetryQueue(tiger); }
        catch { console.error('TELEMETRY_CONFIG_UNAVAILABLE'); }
      }
    } catch (error) {
      nativeSetupReady = false;
      const code = error instanceof Error ? error.message : '';
      nativeStartupError = /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'NATIVE_STARTUP_FAILED';
      nativeAdapter = undefined; nativeSelection = undefined; selectedScenario = undefined; initialPlanner = undefined;
    }
  }
  // Before the window can select a session: one publisher, isolated local config,
  // and a fixed ESM preparation client. No readiness request is sent at boot.
  await hostServices.initialize(preparationClaude);
  pairingHandoff = new CompanionPairingHandoff({ userData: app.getPath('userData'),
    sessionStatus: () => hostServices!.snapshot().session.status,
    issuePairing: () => hostServices!.issuePairing(), isClosing: () => exiting || !!exitAttempt });
  const heartbeat = setInterval(() => { if (!qa.state.running) coordinator.tick(); }, 100);
  const telemetryFlush = setInterval(() => { void telemetry?.flush(); }, 1000);
  app.once('will-quit', () => { clearInterval(heartbeat); clearInterval(telemetryFlush); telemetry?.close(); void tiger?.close();
    void hostServices?.close().catch(() => {});
    void pairingHandoff?.close().then(status => { if (status === 'PAIRING_HANDOFF_CLEANUP_FAILED') console.error(status); }); });
  await createWindow();
  if (pairingQueued) requestCompanionPairing();
}).catch(() => { console.error('SCAFFOLD_START_FAILED'); void hostServices?.close().catch(() => {});
  pairingHandoff?.invalidate(); void pairingHandoff?.close(); exiting = true; app.exit(1); });
app.on('before-quit', event => {
  if (exiting) return;
  event.preventDefault();
  void requestExit().catch(() => undefined);
});
