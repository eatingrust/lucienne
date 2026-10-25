import type { RunEvent } from '../../../contracts/index.js';
import type { CompanionPorts } from './controller.js';
import type { SessionView } from '@lucienne/session/companion';
export const fixtureCode = 'f'.repeat(64);
export function fixtureEvent(type: RunEvent['type'], sequence = 1): RunEvent {
  const phases: Record<RunEvent['type'], RunEvent['phase']> = {
    selected: 'selected', planning: 'planning', progress: 'planning', applying: 'applying', 'target-ready': 'ready',
    'chat-opened': 'chat', 'chat-applied': 'ready', 'chat-closed': 'ready', closing: 'closing',
    'reset-started': 'resetting', 'reset-completed': 'idle', failed: 'error',
  };
  return { version: 1, eventId: `fixture:${sequence}`, runId: 'companion-fixture', requestId: 'fixture-request',
    scenarioId: 'photoshop-contract-example-krita', sequence, generation: 1, at: new Date().toISOString(), monotonicMs: sequence,
    type, phase: phases[type], target: { appId: 'krita', adapterVersion: 'fixture-1' }, mode: 'prepared',
    provider: 'local-fixture', evidenceKind: 'fixture', remainingMs: 60_000, evidenceRefs: [] };
}
/** Explicit in-memory test ports, imported only by the separate fixture entrypoint/tests. */
export function createFixturePorts() {
  let update: ((view: SessionView) => void) | undefined, error: (() => void) | undefined, cursor = 0;
  const ports: CompanionPorts = {
    pairing: { async call(_name, args) {
      if (args.pairingToken !== fixtureCode) throw new Error('FIXTURE_CODE');
      return { streamId: 'fixture-stream', expiresAt: Date.now() + 3600_000 };
    } },
    subscription: { subscribe(_args, onUpdate, onError) {
      update = onUpdate; error = onError;
      onUpdate({ streamId: 'fixture-stream', serverAt: Date.now(), readerExpiresAt: Date.now() + 3600_000,
        cursor: 0, oldestCursor: 1, events: [], gap: false });
      return () => { update = undefined; error = undefined; };
    } },
  };
  return { ports, publish(type: RunEvent['type'], mode: RunEvent['mode'] = 'prepared', gap = false) {
    cursor += gap ? 5 : 1;
    update?.({ streamId: 'fixture-stream', serverAt: Date.now(), readerExpiresAt: Date.now() + 3600_000,
      cursor, oldestCursor: cursor, gap, events: [{ cursor, event: { ...fixtureEvent(type, cursor), mode } }] });
  }, stale() { update?.({ streamId: 'fixture-stream', serverAt: Date.now() - 31_000, readerExpiresAt: Date.now() + 3600_000,
    cursor, oldestCursor: cursor, events: [], gap: false }); },
  expire() { update?.({ streamId: 'fixture-stream', serverAt: Date.now(), readerExpiresAt: Date.now() - 1,
    cursor, oldestCursor: cursor, events: [], gap: false }); }, fail() { error?.(); } };
}
