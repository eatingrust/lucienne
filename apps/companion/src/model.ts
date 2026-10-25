import { RunEventSchema, type RunEvent } from '../../../contracts/index.js';
import type { DisplayState } from './controller.js';
const targetNames = { krita: 'Krita', blender: 'Blender', reaper: 'REAPER', kdenlive: 'Kdenlive' };
const messages: Record<RunEvent['type'], string> = {
  selected: 'Workflow selected', planning: 'Preparing the translation', progress: 'Translation in progress',
  applying: 'Applying changes in the destination', 'target-ready': 'Destination ready',
  'chat-opened': 'Refining the workflow', 'chat-applied': 'Refinement applied', 'chat-closed': 'Refinement closed',
  closing: 'Session ending', 'reset-started': 'Restoring the station', 'reset-completed': 'Ready for the next visitor', failed: 'The station reported a problem',
};
const statusMessages: Record<DisplayState['status'], string> = {
  unconfigured: 'Connection is not configured', pairing: 'Pair this display', connecting: 'Connecting to the station',
  live: 'Waiting for a session', stale: 'Updates are delayed', expired: 'Pairing has expired', error: 'Connection needs attention',
};
export function present(state: DisplayState) {
  const parsed = state.status === 'live' && state.session?.latest ? RunEventSchema.safeParse(state.session.latest) : null;
  const event = parsed?.success ? parsed.data : null;
  const cleared = event?.type === 'reset-started' || event?.type === 'reset-completed';
  return {
    heading: event ? messages[event.type] : statusMessages[state.status],
    connection: state.status === 'live' ? 'Connected' : state.status === 'unconfigured' ? 'Not configured' : state.status,
    target: event && !cleared ? targetNames[event.target.appId] : null,
    mode: event ? { live: 'Live translation', prepared: 'Prepared translation', replay: 'Replay — recorded content', simulated: 'Simulation — demonstration content' }[event.mode] : null,
    evidence: event ? { native: 'Native evidence reported', fixture: 'Fixture verification — no native proof', none: 'No native evidence reported' }[event.evidenceKind] : null,
    remaining: event && !cleared && event.phase !== 'idle' ? `${Math.ceil(event.remainingMs / 1000)} seconds last reported by the station` : null,
    gap: state.status === 'live' && !!state.session?.gap,
    idle: event?.type === 'reset-completed' || (state.status === 'live' && !event),
    failed: event?.type === 'failed',
  };
}
