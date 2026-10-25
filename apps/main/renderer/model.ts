import type { RuntimeState, Command } from '../../../contracts/bridge.js';
import type { SourceApp, TargetApp, ChatIntent } from '../../../contracts/index.js';
import { loadProfiles } from '../../../profiles/index.js';

export const profiles = loadProfiles();
export const labels: Record<SourceApp | TargetApp, string> = {
  photoshop: 'Photoshop', illustrator: 'Illustrator', gimp: 'GIMP', premiere: 'Premiere Pro',
  'after-effects': 'After Effects', resolve: 'DaVinci Resolve', blender: 'Blender', krita: 'Krita', reaper: 'REAPER', kdenlive: 'Kdenlive',
};
export const initialSelection = { profileId: 'photoshop-collage', targetApp: 'krita' as TargetApp };
export const chatPrompts: { intent: ChatIntent; text: string }[] = [
  { intent: 'move-key-panels', text: 'Move Layers to the right' },
  { intent: 'enlarge-work-area', text: 'Give the canvas more room' },
  { intent: 'simplify-tools', text: 'Simplify the visible controls' },
];
export function canReset(state: RuntimeState | null, pending: Command['type'] | null): boolean {
  if (!state || state.qa.running || state.snapshot.phase === 'resetting' || pending === 'reset') return false;
  const preparation = state.services?.preparation;
  const optionalPending = pending !== null && ['quiz-start', 'quiz-answer', 'quiz-accept', 'quiz-cancel',
    'prepare-context', 'preparation-status', 'cancel-preparation'].includes(pending);
  // Acceptance replaces a curated profile in the host catalog and clears quiz.state.
  const acceptedProfile = state.catalog?.profiles.some(profile => profiles.some(base =>
    base.profileId === profile.profileId && base.revision !== profile.revision));
  // Main may retain accepted visitor profiles while its native registry/catalog is
  // unavailable. The bridge has no separate accepted-profile summary in that case.
  const hiddenProfileCleanup = !state.fixtureEnabled && state.quiz !== undefined && state.catalog === undefined;
  return state.snapshot.phase !== 'idle' || pending === 'select-scenario' || optionalPending ||
    !!state.quiz?.state || !!state.quiz?.recoveryRequired || !!acceptedProfile || hiddenProfileCleanup || !!preparation?.busy ||
    !!preparation?.recoveryRequired || preparation?.status === 'recovery-required' ||
    (preparation !== undefined && preparation.context.status !== 'none');
}
export function seconds(milliseconds: number): number { return Math.ceil(Math.max(0, milliseconds) / 1000); }
export function runtimeError(state: RuntimeState | null, commandError: string | null): string | null {
  if (commandError) return commandError;
  if (state?.snapshot.lastError) return state.snapshot.lastError;
  // Startup can fail before a session or command exists. Keep the host's reason
  // visible immediately, without allowing an old boot error to mask an active run.
  return state && !state.fixtureEnabled && state.snapshot.phase === 'idle' ? state.nativeStartupError : null;
}
export function sessionStatus(state: RuntimeState): { title: string; detail: string } {
  const fixture = state.snapshot.evidenceKind === 'fixture' || state.fixtureEnabled;
  switch (state.snapshot.phase) {
    case 'idle': return { title: 'Choose a familiar workflow', detail: 'Choose a source app, a familiar workspace, then a destination to see what this runtime can translate.' };
    case 'selected': return { title: 'Selection confirmed', detail: 'Translate to prepare and apply the supported workspace changes.' };
    case 'planning': return { title: fixture ? 'Planning simulated changes' : 'Planning your workspace', detail: 'The exploration clock starts after the target is confirmed ready.' };
    case 'applying': return { title: fixture ? 'Applying simulated changes' : 'Applying and checking the workspace', detail: 'Waiting for the coordinator to confirm visibility, interaction and native readback.' };
    case 'ready': return fixture ? { title: 'Simulated workspace ready', detail: 'Fixture result only. No creative app has been changed.' } :
      state.snapshot.evidenceKind === 'native' ? { title: 'Your workspace is ready', detail: 'The coordinator confirmed the target is visible, interactive and matches the applied changes.' } :
        { title: 'Waiting for readiness evidence', detail: 'Native readiness has not been confirmed.' };
    case 'chat': return { title: state.snapshot.busy ? 'Updating your workspace' : 'Adjust your workspace', detail: 'The exploration clock is paused. Your source bindings stay protected.' };
    case 'closing': return { title: 'Exploration finished', detail: 'The coordinator will restore the workspace and return to the desktop.' };
    case 'resetting': return { title: 'Restoring the workspace', detail: 'Waiting for the coordinator to restore preferences, clear visitor state and confirm the desktop.' };
    case 'error': return { title: 'The workspace needs recovery', detail: 'Reset again to finish restoring the workspace. If it fails, ask the operator for help.' };
  }
}
export function errorMessage(code: string): string {
  const messages: Record<string, string> = {
    BRIDGE_UNAVAILABLE: 'The desktop connection is unavailable. Reconnect to check the current session.',
    FACTORY_CONFIG_REQUIRED: 'Live translation needs operator setup. Ask the operator to check the configured planner before trying again.',
    NATIVE_STARTUP_FAILED: 'The native runtime could not start. Ask the operator to check startup before trying translation.',
    NATIVE_ADAPTER_NOT_AVAILABLE: 'Native translation is unavailable in this runtime. Ask the operator to check setup.',
    NATIVE_SCENARIO_UNAVAILABLE: 'This workflow is unavailable in the current runtime. Check its availability details before selecting it.',
    NATIVE_SCENARIO_NOT_SELECTED: 'Choose and confirm a workflow before starting translation.',
    KRITA_DEMO_PROCESS_REQUIRED: 'Krita must run from the dedicated demo account. Ask the operator to open Lucienne there.',
    KRITA_DEMO_CONSOLE_REQUIRED: 'The dedicated demo account must be on screen before Krita can run. Ask the operator to switch to it.',
    CONSOLE_CHANGED: 'The active desktop account changed. Ask the operator to return to the demo account and check recovery.',
    KRITA_COMMAND_TIMEOUT: 'Krita did not respond before the host deadline. Check recovery before retrying; readiness has not been confirmed.',
    NATIVE_RESET_UNVERIFIED: 'The host could not confirm complete workspace restoration. Reset again, or ask the operator to finish recovery.',
    DESKTOP_UNVERIFIED: 'The host could not confirm the restored desktop. Ask the operator to check recovery before another run.',
    PLANNER_TIMEOUT: 'Planning timed out. You can retry translation or reset the session.',
    CLAUDE_AUTH_REQUIRED: 'Live chat is unavailable until the operator connects Claude.',
    TARGET_NOT_READY: 'The target did not confirm readiness. Check recovery before trying again.',
    READBACK_MISMATCH: 'The target did not match the requested changes. The coordinator is handling recovery.',
    RESET_REQUIRED: 'Reset the current session before choosing another workflow.',
  };
  return messages[code] ?? 'The runtime could not complete this action. Check the session status, then retry or reset.';
}
