import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunEvent } from '../../../contracts/index.js';
import { CompanionApp } from '../src/App.js';
import { createCompanionController, type DisplayState } from '../src/controller.js';
import { fixtureEvent } from '../src/fixture.js';
import { present } from '../src/model.js';

function live(event: RunEvent | null, gap = false): DisplayState {
  return { status: 'live', busy: false, retryPairing: false, reconnect: false, problem: null,
    session: { status: 'live', latest: event, cursor: 1, gap, events: [] } };
}
function render(state: DisplayState, fixture = false) {
  const controller = { ...createCompanionController(), getSnapshot: () => state };
  return renderToStaticMarkup(createElement(CompanionApp, { controller, fixture }));
}

test('connected fixture readiness remains distinct from live translation and native proof', () => {
  const state = live(fixtureEvent('target-ready'));
  const shown = present(state);
  assert.equal(shown.connection, 'Connected');
  assert.equal(shown.heading, 'Destination ready');
  assert.equal(shown.target, 'Krita');
  assert.equal(shown.mode, 'Prepared translation');
  assert.equal(shown.evidence, 'Fixture verification — no native proof');
  assert.equal(shown.remaining, '60 seconds last reported by the station');
  const html = render(state, true);
  assert.match(html, /Synthetic events\. No native application is connected/);
  assert.match(html, /Prepared translation/);
  assert.doesNotMatch(html, /Live translation|Native evidence reported/);
});

test('every non-live connection state hides a retained event rather than presenting stale readiness', () => {
  for (const status of ['unconfigured', 'pairing', 'connecting', 'stale', 'expired', 'error'] as const) {
    const state = { ...live(fixtureEvent('target-ready')), status };
    const shown = present(state);
    assert.equal(shown.target, null, status);
    assert.equal(shown.remaining, null, status);
    assert.equal(shown.mode, null, status);
    assert.equal(shown.evidence, null, status);
    assert.doesNotMatch(render(state), /Destination ready|Krita|60 seconds/);
  }
});

test('gap renders only latest status, reset clears visitor target/time, and idle stays explicit', () => {
  const gap = live(fixtureEvent('chat-applied'), true);
  const html = render(gap);
  assert.match(html, /Refinement applied/);
  assert.match(html, /Some updates were missed\. Showing only the latest station snapshot/);
  for (const type of ['reset-started', 'reset-completed'] as const) {
    const state = live(fixtureEvent(type));
    const shown = present(state);
    assert.equal(shown.target, null);
    assert.equal(shown.remaining, null);
    assert.doesNotMatch(render(state), /Destination:|seconds last reported/);
  }
  assert.match(render(live(fixtureEvent('reset-completed'))), /Idle display/);
  assert.match(render(live(null)), /Idle display/);
  assert.equal(present(live(null)).heading, 'Waiting for a session');
});

test('replay/simulation stay labeled and a failed chat with ready phase still reports failure', () => {
  for (const mode of ['replay', 'simulated'] as const) {
    const html = render(live({ ...fixtureEvent('target-ready'), mode }));
    assert.match(html, mode === 'replay' ? /Replay — recorded content/ : /Simulation — demonstration content/);
  }
  const state = live({ ...fixtureEvent('failed'), phase: 'ready' });
  assert.equal(present(state).failed, true);
  assert.match(render(state), /The station reported a problem/);
  assert.match(render(state), /Continue on the main Mac to resolve/);
});

test('passive markup never exposes technical IDs, raw error codes, evidence paths or native command controls', () => {
  const event: RunEvent = { ...fixtureEvent('failed'), runId: 'secret-run-marker', requestId: 'secret-request-marker',
    scenarioId: 'secret-scenario-marker', provider: 'secret-provider-marker', code: 'secret-error-marker',
    evidenceRefs: ['private/path/secret-evidence-marker'], target: { appId: 'krita', adapterVersion: 'secret-adapter-marker' } };
  const html = render(live(event));
  assert.doesNotMatch(html, /secret-|private\/path/);
  const buttons = [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(buttons, ['Clear pairing']);
  assert.doesNotMatch(html, /window\.lucienne|open-chat|select-krita|start-native-qa|complete-qa-step/);
});

test('pairing form conceals entered capabilities and raw errors never become display copy', () => {
  const state: DisplayState = { status: 'error', busy: false, retryPairing: true, reconnect: false, problem: 'pairing', session: null };
  const html = render(state);
  assert.match(html, /type="password"/);
  assert.match(html, /autocomplete="off"/i);
  assert.match(html, /Retry saved pairing/);
  assert.doesNotMatch(html, /[a-f0-9]{64}|readerToken|pairingToken/);
});

test('malformed events do not turn into live status content', () => {
  const invalid = { ...fixtureEvent('target-ready'), remainingMs: -1 } as RunEvent;
  assert.equal(present(live(invalid)).heading, 'Waiting for a session');
  assert.doesNotMatch(render(live(invalid)), /Destination ready|Krita|seconds last reported/);
});
