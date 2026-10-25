import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SessionCoordinator, type CommittedPatchMetadata } from '../session.js';
import { makeFixture } from '../fixture.js';
import { validateRequest, type PlannerRequest, type PlannerResult, type RunEvent } from '../../contracts/index.js';
import type { NativeAdapter, NativeReadback, NativeResetResult, PlannerPort } from '../../contracts/ports.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  const fixture = makeFixture(validateRequest(JSON.parse(readFileSync(new URL('../../contracts/examples/planner-request.json', import.meta.url), 'utf8'))));
  const events: RunEvent[] = [];
  let id = 0;
  const core = new SessionCoordinator({ desktop: fixture.desktop, id: () => `disclosure-run-${++id}`, onEvent: event => { events.push(event); } });
  const adapter: NativeAdapter = { ...fixture.adapter };
  const planner = (limitations: string[]): PlannerPort => ({ ...fixture.planner, async plan(request, context) {
    const output = await fixture.planner.plan(request, context);
    output.patch.limitations = [...limitations];
    return output;
  } });
  const select = () => core.select(fixture.selection, adapter);
  select();
  return { core, adapter, fixture, planner, events, select };
}

test('committed metadata appears only after verified initial readback and is deeply clone-isolated', async () => {
  const { core, adapter, planner, events } = setup();
  assert.equal(core.snapshot().committedPatch, null);
  const gate = deferred<void>();
  const originalReadback = adapter.readback;
  adapter.readback = async context => { await gate.promise; return originalReadback(context); };
  const task = core.translate(planner(['Verified limitation.']));
  await flush();
  assert.equal(core.snapshot().phase, 'applying');
  assert.equal(core.snapshot().committedPatch, null);
  gate.resolve(); await task;
  const ready = events.find(event => event.type === 'target-ready')!;
  const expected = { runId: ready.runId, requestId: ready.requestId!, generation: ready.generation, limitations: ['Verified limitation.'] };
  assert.deepEqual(core.snapshot().committedPatch, expected);
  const external = core.snapshot().committedPatch!;
  external.limitations.push('External mutation'); external.runId = 'wrong-run'; external.requestId = 'wrong-request'; external.generation = -1;
  assert.deepEqual(core.snapshot().committedPatch, expected);
  await core.reset();
});

test('pending chat retains old metadata through planning/apply until successful readback replaces it', async () => {
  const { core, adapter, planner, events } = setup();
  await core.translate(planner(['Initial verified limitation.']));
  const initial = core.snapshot().committedPatch!;
  core.openChat();
  const planGate = deferred<void>();
  const readGate = deferred<void>();
  const previousReadback = adapter.readback;
  adapter.readback = async context => { await readGate.promise; return previousReadback(context); };
  const base = planner(['Changed verified limitation.']);
  const delayed: PlannerPort = { ...base, async plan(request, context) { await planGate.promise; return base.plan(request, context); } };
  const task = core.chat(delayed, { intent: 'enlarge-work-area', instruction: 'Enlarge', explicit: [{ key: 'work-area', value: 'large' }] });
  await flush(); assert.deepEqual(core.snapshot().committedPatch, initial);
  planGate.resolve(); await flush();
  assert.deepEqual(core.snapshot().committedPatch, initial);
  readGate.resolve(); await task;
  const changed = core.snapshot().committedPatch!;
  const event = events.find(event => event.type === 'chat-applied')!;
  assert.notEqual(changed.requestId, initial.requestId);
  assert.deepEqual(changed, { runId: event.runId, requestId: event.requestId!, generation: event.generation, limitations: ['Changed verified limitation.'] });
  await core.reset();
});

test('failed planning and invalid chat patches retain the last verified disclosure and identity', async () => {
  const { core, planner } = setup();
  await core.translate(planner(['Last verified.']));
  const before = core.snapshot().committedPatch;
  core.openChat();
  await assert.rejects(core.chat({ provider: 'local-fixture', mode: 'prepared', async plan() { throw new Error('PLANNER_FAILED'); } },
    { intent: 'enlarge-work-area', instruction: 'Enlarge' }), /PLANNER_FAILED/);
  assert.equal(core.snapshot().phase, 'ready');
  assert.deepEqual(core.snapshot().committedPatch, before);
  core.openChat();
  const valid = planner(['Unapplied replacement.']);
  await assert.rejects(core.chat({ ...valid, async plan(request, context) {
    const output = await valid.plan(request, context); output.patch.operations.pop(); return output;
  } }, { intent: 'simplify-tools', instruction: 'Simplify' }), /INCOMPLETE_PATCH/);
  assert.equal(core.snapshot().phase, 'ready');
  assert.deepEqual(core.snapshot().committedPatch, before);
  await core.reset();
});

test('failed initial planning never publishes uncommitted limitation metadata', async () => {
  const { core, planner } = setup();
  const valid = planner(['Not applied.']);
  await assert.rejects(core.translate({ ...valid, async plan(request, context) {
    const output = await valid.plan(request, context); output.patch.operations.pop(); return output;
  } }), /INCOMPLETE_PATCH/);
  assert.equal(core.snapshot().phase, 'selected');
  assert.equal(core.snapshot().committedPatch, null);
  await core.reset();
});

test('late aborted planner output cannot republish prior visitor metadata over a new session', async () => {
  const { core, planner, select } = setup();
  await core.translate(planner(['Prior visitor.']));
  core.openChat();
  const gate = deferred<PlannerResult>();
  let oldRequest!: PlannerRequest;
  const delayed: PlannerPort = { provider: 'local-fixture', mode: 'prepared', async plan(request) { oldRequest = request; return gate.promise; } };
  const task = core.chat(delayed, { intent: 'enlarge-work-area', instruction: 'Enlarge' });
  const rejected = assert.rejects(task, /OPERATOR_RESET/);
  await flush(); await core.reset(); await rejected;
  assert.equal(core.snapshot().committedPatch, null);
  select(); await core.translate(planner(['New visitor.']));
  const current = core.snapshot().committedPatch;
  const output = await planner(['Late stale notice.']).plan(oldRequest, { signal: new AbortController().signal, onProgress() {} });
  gate.resolve(output); await flush();
  assert.deepEqual(core.snapshot().committedPatch, current);
  await core.reset();
});

test('stale readback after reset never publishes its proposed metadata', async () => {
  const { core, adapter, planner } = setup();
  const gate = deferred<NativeReadback>();
  const previousReadback = adapter.readback;
  let observed!: NativeReadback;
  adapter.readback = async context => { observed = await previousReadback(context); return gate.promise; };
  const task = core.translate(planner(['Stale native result.']));
  const rejected = assert.rejects(task, /STALE_RESULT/);
  await flush();
  const reset = core.reset();
  assert.equal(core.snapshot().committedPatch, null);
  gate.resolve(observed); await Promise.all([rejected, reset]);
  assert.equal(core.snapshot().phase, 'idle');
  assert.equal(core.snapshot().committedPatch, null);
});

test('reset clears exposure immediately and failed recovery does not pretend a valid active commit', async () => {
  const { core, adapter, planner, select } = setup();
  await core.translate(planner(['Sensitive visitor-specific limitation.']));
  assert.ok(core.snapshot().committedPatch);
  const gate = deferred<NativeResetResult>();
  const previousReset = adapter.reset;
  adapter.reset = () => gate.promise;
  const reset = core.reset();
  const rejected = assert.rejects(reset, /NATIVE_RESET_UNVERIFIED/);
  assert.equal(core.snapshot().phase, 'resetting');
  assert.equal(core.snapshot().runId, null);
  assert.equal(core.snapshot().committedPatch, null);
  gate.resolve({ targetClosed: false, preferencesRestored: false, visitorArtifactsCleared: false, evidenceRefs: ['fixture:failed-reset'] });
  await rejected;
  assert.equal(core.snapshot().phase, 'error');
  assert.equal(core.snapshot().committedPatch, null);
  assert.throws(select, /RESET_REQUIRED/);
  adapter.reset = previousReset;
  await core.reset(); select();
  assert.equal(core.snapshot().committedPatch, null);
  await core.reset();
});

test('native chat readback failure never exposes new notices and recovery clears the old record', async () => {
  const { core, adapter, planner } = setup();
  await core.translate(planner(['Old verified.']));
  const old = core.snapshot().committedPatch!;
  const seen: Array<CommittedPatchMetadata | null> = [];
  const unsubscribe = core.subscribe(snapshot => seen.push(snapshot.committedPatch));
  core.openChat();
  const original = adapter.readback;
  adapter.readback = async context => ({ ...await original(context), interactive: false });
  await assert.rejects(core.chat(planner(['New unverified.']), { intent: 'enlarge-work-area', instruction: 'Enlarge' }), /TARGET_NOT_READY/);
  assert.ok(seen.some(value => value?.requestId === old.requestId));
  assert.equal(seen.some(value => value?.limitations.includes('New unverified.')), false);
  assert.equal(core.snapshot().phase, 'idle');
  assert.equal(core.snapshot().committedPatch, null);
  unsubscribe();
});
