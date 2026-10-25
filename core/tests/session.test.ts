import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SessionCoordinator, type Clock, type Selection } from '../session.js';
import { validateRequest, type NativePatch, type PlannerRequest, type PlannerResult, type RunEvent } from '../../contracts/index.js';
import type { CommitContext, DesktopPort, NativeAdapter, NativeReadback, NativeResetResult, PlannerPort } from '../../contracts/ports.js';

const example = validateRequest(JSON.parse(readFileSync(new URL('../../contracts/examples/planner-request.json', import.meta.url), 'utf8')));
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class FakeClock implements Clock {
  ms = 0;
  now() { return this.ms; }
  iso() { return new Date(Date.UTC(2026, 9, 25) + this.ms).toISOString(); }
  advance(ms: number) { this.ms += ms; }
}
function resultFor(request: PlannerRequest): PlannerResult {
  const desired = new Map(request.source.preferences.map(p => [p.key, p.value]));
  request.explicit.forEach(p => desired.set(p.key, p.value));
  const previous = new Map(request.currentOperations.map(p => [p.capabilityId, p.value]));
  return {
    patch: {
      version: 1, runId: request.runId, requestId: request.requestId, scenarioId: request.scenarioId,
      target: structuredClone(request.target),
      operations: request.catalog.map(capability => ({ capabilityId: capability.id,
        value: capability.bindingAction ? request.source.bindings[capability.bindingAction]! :
          (capability.preferenceKey && desired.get(capability.preferenceKey)) || previous.get(capability.id) || capability.values[0]!,
      })),
      evidenceRefs: [...request.evidenceRefs], summary: 'Test fixture patch', limitations: ['Synthetic lifecycle test only.'],
    },
    provenance: { mode: 'prepared', provider: 'test-planner', evidenceRefs: [...request.evidenceRefs] },
  };
}
function planner(plan: PlannerPort['plan'] = async request => resultFor(request)): PlannerPort {
  return { provider: 'test-planner', mode: 'prepared', plan };
}
class FakeAdapter implements NativeAdapter {
  target = structuredClone(example.target);
  evidenceKind = 'fixture' as const;
  catalog = structuredClone(example.catalog);
  calls: string[] = [];
  state: NativePatch | null = null;
  onApply?: (patch: NativePatch, request: PlannerRequest, context: CommitContext) => Promise<void>;
  onReadback?: (context: CommitContext) => Promise<NativeReadback>;
  onReset?: () => Promise<NativeResetResult>;
  async apply(patch: NativePatch, request: PlannerRequest, context: CommitContext) {
    this.calls.push('apply:start');
    if (this.onApply) await this.onApply(patch, request, context);
    this.state = structuredClone(patch);
    this.calls.push('apply:end');
  }
  async readback(context: CommitContext): Promise<NativeReadback> {
    this.calls.push('readback');
    if (this.onReadback) return this.onReadback(context);
    return { requestId: this.state!.requestId, targetVisible: true, interactive: true,
      operations: structuredClone(this.state!.operations), evidenceRefs: ['fixture:readback'] };
  }
  async reset(): Promise<NativeResetResult> {
    this.calls.push('reset:start');
    if (this.onReset) return this.onReset();
    this.state = null;
    this.calls.push('reset:end');
    return resetSuccess();
  }
}
function resetSuccess(): NativeResetResult {
  return { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true, evidenceRefs: ['fixture:reset'] };
}
function setup(options: { onEvent?: (event: RunEvent) => void; desktop?: DesktopPort; timeout?: number } = {}) {
  const clock = new FakeClock();
  const adapter = new FakeAdapter();
  const events: RunEvent[] = [];
  const desktopCalls: string[] = [];
  let serial = 0;
  const core = new SessionCoordinator({ clock, id: () => `test-run-${++serial}`, plannerTimeoutMs: options.timeout,
    desktop: options.desktop ?? { async returnToDesktop() { desktopCalls.push('desktop'); return { desktopVisible: true, evidenceRefs: ['fixture:desktop'] }; } },
    onEvent(event) { events.push(structuredClone(event)); options.onEvent?.(event); },
  });
  const selection: Selection = { scenarioId: example.scenarioId, source: structuredClone(example.source), target: structuredClone(example.target) };
  const select = () => core.select(selection, adapter);
  select();
  return { core, clock, adapter, events, desktopCalls, selection, select };
}

test('readiness waits for apply and complete readback before starting 60 seconds', async () => {
  const { core, adapter, clock, events } = setup();
  const applied = deferred<void>();
  const read = deferred<NativeReadback>();
  adapter.onApply = () => applied.promise;
  adapter.onReadback = () => read.promise;
  const task = core.translate(planner());
  await flush();
  clock.advance(120_000);
  core.tick();
  assert.equal(core.snapshot().phase, 'applying');
  assert.equal(core.snapshot().remainingMs, 60_000);
  applied.resolve();
  await flush();
  assert.equal(events.some(e => e.type === 'target-ready'), false);
  read.resolve({ requestId: adapter.state!.requestId, targetVisible: true, interactive: true,
    operations: [...adapter.state!.operations].reverse(), evidenceRefs: ['fixture:readback'] });
  await task;
  assert.equal(core.snapshot().phase, 'ready');
  assert.equal(core.snapshot().remainingMs, 60_000);
  assert.equal(events.at(-1)!.type, 'target-ready');
  assert.equal(events.at(-1)!.evidenceKind, 'fixture');
  clock.advance(1_000);
  assert.equal(core.snapshot().remainingMs, 59_000);
  await core.reset();
});

test('trusted host operations expose only verified commits, are cloned, and clear immediately on reset', async () => {
  const { core, adapter } = setup();
  assert.deepEqual(core.committedOperations(), []);
  const read = deferred<NativeReadback>();
  adapter.onReadback = () => read.promise;
  const translation = core.translate(planner());
  await flush();
  assert.deepEqual(core.committedOperations(), []);
  const patch = structuredClone(adapter.state!);
  read.resolve({ requestId: patch.requestId, targetVisible: true, interactive: true,
    operations: patch.operations, evidenceRefs: ['fixture:readback'] });
  await translation;
  const expected = structuredClone(patch.operations);
  const exposed = core.committedOperations();
  assert.deepEqual(exposed, expected);
  exposed[0]!.value = 'caller-mutation';
  exposed.splice(1);
  assert.deepEqual(core.committedOperations(), expected);
  const resetGate = deferred<NativeResetResult>();
  adapter.onReset = () => resetGate.promise;
  const resetting = core.reset();
  assert.deepEqual(core.committedOperations(), []);
  resetGate.resolve(resetSuccess());
  await resetting;
  assert.deepEqual(core.committedOperations(), []);
});

test('reset waits for an abort-ignoring apply, restores last, and gates another visitor', async () => {
  const { core, adapter, events, select, desktopCalls } = setup();
  const gate = deferred<void>();
  let context!: CommitContext;
  adapter.onApply = async (_patch, _request, ctx) => { context = ctx; await gate.promise; };
  const task = core.translate(planner());
  const rejected = assert.rejects(task, /STALE_RESULT/);
  await flush();
  const reset = core.reset();
  assert.equal(context.signal.aborted, true);
  assert.equal(context.isCurrent(), false);
  assert.equal(core.snapshot().runId, null);
  assert.equal(core.snapshot().phase, 'resetting');
  assert.throws(select, /RESET_REQUIRED/);
  await flush();
  assert.deepEqual(adapter.calls, ['apply:start']);
  assert.deepEqual(desktopCalls, []);
  gate.resolve();
  await Promise.all([rejected, reset]);
  assert.deepEqual(adapter.calls, ['apply:start', 'apply:end', 'reset:start', 'reset:end']);
  assert.deepEqual(desktopCalls, ['desktop']);
  assert.equal(adapter.state, null);
  assert.equal(events.some(e => e.type === 'target-ready'), false);
  assert.equal(core.snapshot().phase, 'idle');
  select();
  await core.reset();
});

test('reset during pending readback waits for settlement and excludes late readiness', async () => {
  const { core, adapter, events } = setup();
  const read = deferred<NativeReadback>();
  adapter.onReadback = () => read.promise;
  const task = core.translate(planner());
  const rejected = assert.rejects(task, /STALE_RESULT/);
  await flush();
  const patch = structuredClone(adapter.state!);
  const reset = core.reset();
  await flush();
  assert.equal(adapter.calls.includes('reset:start'), false);
  read.resolve({ requestId: patch.requestId, operations: patch.operations, targetVisible: true, interactive: true, evidenceRefs: ['fixture:readback'] });
  await Promise.all([reset, rejected]);
  assert.equal(events.some(e => e.type === 'target-ready'), false);
  assert.equal(adapter.state, null);
});

test('late planner response and progress after reset cannot touch a new run', async () => {
  const { core, adapter, events, select } = setup();
  const output = deferred<PlannerResult>();
  let oldRequest!: PlannerRequest;
  let lateProgress!: () => void;
  const old = core.translate(planner(async (request, context) => { oldRequest = request; lateProgress = context.onProgress; return output.promise; }));
  const rejected = assert.rejects(old, /OPERATOR_RESET/);
  await flush();
  await core.reset();
  await rejected;
  select();
  await core.translate(planner());
  const runId = core.snapshot().runId;
  const count = events.length;
  const calls = [...adapter.calls];
  lateProgress();
  output.resolve(resultFor(oldRequest));
  await flush();
  assert.equal(core.snapshot().runId, runId);
  assert.equal(core.snapshot().phase, 'ready');
  assert.equal(events.length, count);
  assert.deepEqual(adapter.calls, calls);
  await core.reset();
});

for (const phase of ['planning', 'applying'] as const) test(`synchronous ${phase} observer reset prevents native commit`, async () => {
  let core!: SessionCoordinator;
  let reset: Promise<void> | undefined;
  let plannerCalls = 0;
  const env = setup({ onEvent(event) { if (event.type === phase) reset = core.reset(); } });
  core = env.core;
  await assert.rejects(core.translate(planner(async request => { plannerCalls++; return resultFor(request); })), /STALE_RESULT/);
  await reset;
  assert.equal(env.adapter.calls.includes('apply:start'), false);
  if (phase === 'planning') assert.equal(plannerCalls, 0);
  assert.equal(core.snapshot().phase, 'idle');
});

test('reset-started observer reentrancy shares one reset and observer failures are isolated', async () => {
  let core!: SessionCoordinator;
  let second: Promise<void> | undefined;
  const env = setup({ onEvent(event) { if (event.type === 'reset-started') second = core.reset(); throw new Error('telemetry offline'); } });
  core = env.core;
  core.subscribe(() => { throw new Error('renderer disconnected'); });
  await core.translate(planner());
  const first = core.reset();
  assert.equal(first, second);
  await first;
  assert.equal(env.adapter.calls.filter(call => call === 'reset:start').length, 1);
  assert.equal(core.snapshot().phase, 'idle');
});

test('60/30/20 timing pauses chat, extends a successful late change, then resets', async () => {
  const { core, clock, adapter, events } = setup();
  await core.translate(planner());
  clock.advance(35_000);
  core.openChat();
  assert.equal(core.snapshot().remainingMs, 25_000);
  clock.advance(120_000);
  core.tick();
  assert.equal(core.snapshot().phase, 'chat');
  assert.equal(core.snapshot().remainingMs, 25_000);
  await core.chat(planner(), { intent: 'enlarge-work-area', instruction: 'Enlarge canvas', explicit: [{ key: 'work-area', value: 'large' }] });
  assert.equal(core.snapshot().phase, 'ready');
  assert.equal(core.snapshot().remainingMs, 30_000);
  assert.equal(adapter.state!.operations.find(op => op.capabilityId === 'work-area.size')!.value, 'large');
  clock.advance(29_999); core.tick();
  assert.equal(core.snapshot().phase, 'ready');
  clock.advance(1); core.tick();
  assert.equal(core.snapshot().phase, 'closing');
  assert.equal(core.snapshot().closingRemainingMs, 20_000);
  clock.advance(19_999); core.tick();
  assert.equal(core.snapshot().phase, 'closing');
  clock.advance(1); core.tick();
  await flush();
  assert.equal(core.snapshot().phase, 'idle');
  assert.equal(events.at(-1)!.type, 'reset-completed');
});

test('chat closure and failed planning resume the previous remainder without extension', async () => {
  const { core, clock } = setup();
  await core.translate(planner());
  clock.advance(40_000); core.openChat();
  clock.advance(90_000); core.closeChat();
  assert.equal(core.snapshot().remainingMs, 20_000);
  clock.advance(5_000); core.openChat();
  clock.advance(90_000);
  await assert.rejects(core.chat(planner(async () => { throw new Error('PROVIDER_UNAVAILABLE'); }), { intent: 'simplify-tools', instruction: 'Simplify' }), /PROVIDER_UNAVAILABLE/);
  assert.equal(core.snapshot().phase, 'ready');
  assert.equal(core.snapshot().remainingMs, 15_000);
  assert.equal(core.snapshot().lastError, 'PROVIDER_UNAVAILABLE');
  await core.reset();
});

test('successful early chat keeps more than 30 seconds and explicit choices persist', async () => {
  const { core, clock, adapter } = setup();
  await core.translate(planner());
  clock.advance(5_000); core.openChat();
  await core.chat(planner(), { intent: 'move-key-panels', instruction: 'Right', explicit: [{ key: 'panel-side', value: 'right' }] });
  assert.equal(core.snapshot().remainingMs, 55_000);
  core.openChat();
  let received!: PlannerRequest;
  await core.chat(planner(async request => { received = request; return resultFor(request); }), { intent: 'simplify-tools', instruction: 'Simplify' });
  assert.deepEqual(received.explicit, [{ key: 'panel-side', value: 'right' }]);
  assert.equal(adapter.state!.operations.find(op => op.capabilityId === 'panels.side')!.value, 'right');
  await core.reset();
});

test('a long clock stall still gives the full closing interval', async () => {
  const { core, clock } = setup();
  await core.translate(planner());
  clock.advance(300_000); core.tick();
  assert.equal(core.snapshot().phase, 'closing');
  assert.equal(core.snapshot().closingRemainingMs, 20_000);
  assert.throws(() => core.openChat(), /INVALID_STATE/);
  await core.reset();
});

const invalidReadbacks: Record<string, (value: NativeReadback) => void> = {
  'wrong request': value => { value.requestId = 'previous-request'; },
  'hidden target': value => { value.targetVisible = false; },
  'unresponsive target': value => { value.interactive = false; },
  'missing evidence': value => { value.evidenceRefs = []; },
  'incomplete values': value => { value.operations.pop(); },
  'different values': value => { value.operations.find(op => op.capabilityId === 'work-area.size')!.value = 'large'; },
};
for (const [name, change] of Object.entries(invalidReadbacks)) test(`readiness rejects ${name}, restores, and never announces target ready`, async () => {
  const { core, adapter, events } = setup();
  adapter.onReadback = async () => {
    const observed: NativeReadback = { requestId: adapter.state!.requestId, targetVisible: true, interactive: true,
      operations: structuredClone(adapter.state!.operations), evidenceRefs: ['fixture:readback'] };
    change(observed);
    return observed;
  };
  await assert.rejects(core.translate(planner()));
  assert.equal(core.snapshot().phase, 'idle');
  assert.equal(adapter.state, null);
  assert.equal(events.some(event => event.type === 'target-ready'), false);
  assert.equal(events.at(-1)!.type, 'reset-completed');
});

test('partial native failure requires restoration before another session', async () => {
  const { core, adapter, select, events } = setup();
  const resetGate = deferred<NativeResetResult>();
  adapter.onApply = async patch => { adapter.state = structuredClone(patch); throw new Error('PARTIAL_NATIVE_WRITE'); };
  adapter.onReset = () => resetGate.promise;
  const task = core.translate(planner());
  const rejected = assert.rejects(task, /PARTIAL_NATIVE_WRITE/);
  await flush();
  assert.equal(core.snapshot().phase, 'resetting');
  assert.throws(select, /RESET_REQUIRED/);
  assert.equal(events.some(event => event.type === 'target-ready'), false);
  adapter.state = null;
  resetGate.resolve(resetSuccess());
  await rejected;
  assert.equal(core.snapshot().phase, 'idle');
});

test('failed native restoration blocks reuse until a verified recovery succeeds', async () => {
  const { core, adapter, select, events, desktopCalls } = setup();
  await core.translate(planner());
  adapter.onReset = async () => ({ ...resetSuccess(), preferencesRestored: false });
  await assert.rejects(core.reset(), /NATIVE_RESET_UNVERIFIED/);
  assert.equal(core.snapshot().phase, 'error');
  assert.equal(core.snapshot().runId, null);
  assert.throws(select, /RESET_REQUIRED/);
  assert.deepEqual(desktopCalls, []);
  assert.equal(events.some(event => event.type === 'reset-completed'), false);
  adapter.onReset = undefined;
  await core.reset();
  assert.equal(core.snapshot().phase, 'idle');
  select();
  await core.reset();
});

test('unverified desktop prevents reset completion and permits explicit recovery retry', async () => {
  let visible = false;
  const { core, select, events } = setup({ desktop: { async returnToDesktop() { return { desktopVisible: visible, evidenceRefs: ['fixture:desktop'] }; } } });
  await core.translate(planner());
  await assert.rejects(core.reset(), /DESKTOP_UNVERIFIED/);
  assert.throws(select, /RESET_REQUIRED/);
  assert.equal(events.some(event => event.type === 'reset-completed'), false);
  visible = true;
  await core.reset();
  assert.equal(core.snapshot().phase, 'idle');
});

test('caller, planner, event, and snapshot mutation cannot alter coordinator selection', async () => {
  const { core, selection, adapter } = setup({ onEvent(event) { event.target.appId = 'blender'; event.runId = 'changed-event'; } });
  const profileId = selection.source.profileId;
  selection.source.profileId = 'changed-input';
  selection.source.bindings.pan = 'changed-binding';
  selection.target.appId = 'blender';
  core.snapshot().target!.appId = 'reaper';
  let firstRequest!: PlannerRequest;
  await core.translate(planner(async request => {
    firstRequest = structuredClone(request);
    const output = resultFor(request);
    request.source.profileId = 'changed-planner-copy';
    request.target.appId = 'blender';
    request.explicit.push({ key: 'work-area', value: 'large' });
    return output;
  }));
  assert.equal(firstRequest.source.profileId, profileId);
  assert.equal(firstRequest.source.bindings.pan, 'Space');
  assert.equal(core.snapshot().target!.appId, 'krita');
  assert.equal(adapter.state!.target.appId, 'krita');
  core.openChat();
  await core.chat(planner(async request => {
    assert.equal(request.source.profileId, profileId);
    assert.deepEqual(request.explicit, []);
    return resultFor(request);
  }), { intent: 'simplify-tools', instruction: 'Simplify' });
  await core.reset();
});

test('planner timeout aborts and late output cannot apply; selected session may retry', async () => {
  const { core, adapter, events } = setup({ timeout: 10 });
  const delayed = deferred<PlannerResult>();
  let request!: PlannerRequest;
  let signal!: AbortSignal;
  await assert.rejects(core.translate(planner(async (input, context) => { request = input; signal = context.signal; return delayed.promise; })), /PLANNER_TIMEOUT/);
  assert.equal(signal.aborted, true);
  assert.equal(core.snapshot().phase, 'selected');
  assert.equal(adapter.calls.includes('apply:start'), false);
  delayed.resolve(resultFor(request));
  await flush();
  assert.equal(events.some(event => event.type === 'target-ready'), false);
  await core.translate(planner());
  assert.equal(core.snapshot().phase, 'ready');
  await core.reset();
});

test('a successful no-op chat below 30 seconds does not extend exploration', async () => {
  const { core, clock, adapter } = setup();
  await core.translate(planner());
  const before = structuredClone(adapter.state!.operations);
  clock.advance(45_000);
  core.openChat();
  clock.advance(120_000);
  await core.chat(planner(async request => {
    const result = resultFor(request);
    // Order has no semantic meaning; the same values must still count as unchanged.
    result.patch.operations.reverse();
    return result;
  }), { intent: 'enlarge-work-area', instruction: 'Keep the current canvas size' });
  assert.equal(core.snapshot().phase, 'ready');
  assert.equal(core.snapshot().remainingMs, 15_000);
  assert.deepEqual([...adapter.state!.operations].reverse(), before);
  clock.advance(15_000);
  core.tick();
  assert.equal(core.snapshot().phase, 'closing');
  assert.equal(core.snapshot().closingRemainingMs, 20_000);
  await core.reset();
});

test('combined native and desktop evidence cannot strand a successful reset', async () => {
  const { core, adapter, events, select } = setup();
  await core.translate(planner());
  adapter.onReset = async () => {
    adapter.state = null;
    return { ...resetSuccess(), evidenceRefs: Array.from({ length: 32 }, (_, index) => `fixture:reset:${index}`) };
  };
  await core.reset();
  const completion = [...events].reverse().find(event => event.type === 'reset-completed');
  assert.ok(completion);
  assert.ok(completion.evidenceRefs.length > 0 && completion.evidenceRefs.length <= 32);
  assert.equal(new Set(completion.evidenceRefs).size, completion.evidenceRefs.length);
  assert.equal(core.snapshot().phase, 'idle');
  select();
  assert.equal(core.snapshot().phase, 'selected');
  await core.reset();
});

test('a hung native reset remains visibly resetting and blocks selection until it settles', async () => {
  const { core, adapter, select, events, desktopCalls } = setup();
  await core.translate(planner());
  const gate = deferred<NativeResetResult>();
  adapter.onReset = () => gate.promise;
  const reset = core.reset();
  await flush();
  assert.equal(core.snapshot().phase, 'resetting');
  assert.equal(core.snapshot().busy, true);
  assert.equal(core.snapshot().runId, null);
  assert.throws(select, /RESET_REQUIRED/);
  assert.equal(core.reset(), reset);
  assert.equal(events.some(event => event.type === 'reset-completed'), false);
  assert.deepEqual(desktopCalls, []);
  adapter.state = null;
  gate.resolve(resetSuccess());
  await reset;
  assert.equal(core.snapshot().phase, 'idle');
  assert.equal(core.snapshot().busy, false);
  select();
  await core.reset();
});

test('trusted initial preparation reaches planner and native validation with its added evidence', async () => {
  const { core, adapter } = setup();
  const gate = deferred<PlannerRequest>();
  let original!: PlannerRequest;
  let prepSignal!: AbortSignal;
  let plannerRequest!: PlannerRequest;
  let adapterRequest!: PlannerRequest;
  let preparations = 0;
  adapter.onApply = async (_patch, request) => { adapterRequest = structuredClone(request); };
  const translation = core.translate(planner(async request => {
    plannerRequest = structuredClone(request); return resultFor(request);
  }), async (request, signal) => {
    preparations++; original = request; prepSignal = signal; return gate.promise;
  });
  await flush();
  assert.equal(core.snapshot().phase, 'planning');
  assert.equal(core.snapshot().remainingMs, 60_000);
  assert.equal(prepSignal.aborted, false);
  assert.deepEqual(adapter.calls, []);
  const enriched = { ...original, instruction: 'PREPARED EVIDENCE: reviewed fixture only.',
    evidenceRefs: [...original.evidenceRefs, 'fixture:prepared-document'] };
  gate.resolve(enriched);
  await translation;
  assert.deepEqual(plannerRequest, enriched);
  assert.deepEqual(adapterRequest, enriched);
  assert.deepEqual(adapter.state!.evidenceRefs, enriched.evidenceRefs);
  assert.equal(core.snapshot().phase, 'ready');
  // Preparation belongs to this initial request; chat continues to use source authority.
  core.openChat();
  await core.chat(planner(async request => {
    assert.equal(request.instruction, 'Simplify');
    assert.deepEqual(request.evidenceRefs, original.evidenceRefs);
    return resultFor(request);
  }), { intent: 'simplify-tools', instruction: 'Simplify' });
  assert.equal(preparations, 1);
  await core.reset();
});

test('initial preparation cannot substitute request authority or remove, reorder, or duplicate evidence', async t => {
  const changes: Record<string, (request: PlannerRequest) => void> = {
    'run identity': request => { request.runId = 'substituted-run'; },
    'request identity': request => { request.requestId = 'substituted-request'; },
    'scenario': request => { request.scenarioId = 'substituted-scenario'; },
    'source profile': request => { request.source.label = 'Substituted source'; },
    'source bindings': request => { request.source.bindings.pan = 'P'; },
    'adapter version': request => { request.target.adapterVersion = 'substituted-adapter'; },
    'catalog': request => { request.catalog[0]!.values.push('invented-value'); },
    'explicit preferences': request => { request.explicit.push({ key: 'work-area', value: 'large' }); },
    'current operations': request => { request.currentOperations.push({ capabilityId: request.catalog[0]!.id, value: request.catalog[0]!.values[0]! }); },
    'binding policy': request => { request.bindingApplicability = { version: 1, scenarioId: request.scenarioId,
      source: { profileId: request.source.profileId, revision: request.source.revision, sourceApp: request.source.sourceApp },
      target: request.target, entries: [] }; },
    'removed evidence': request => { request.evidenceRefs = []; },
    'reordered evidence': request => { request.evidenceRefs.unshift('fixture:added-before-source'); },
    'duplicate evidence': request => { request.evidenceRefs.push(request.evidenceRefs[0]!); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async () => {
    const { core, adapter, events } = setup();
    let plannerCalls = 0;
    await assert.rejects(core.translate(planner(async request => { plannerCalls++; return resultFor(request); }), async request => {
      // Mutating the callback's input cannot change the coordinator's baseline.
      change(request); return request;
    }), /PREPARATION_REQUEST_INVALID/);
    assert.equal(plannerCalls, 0);
    assert.deepEqual(adapter.calls, []);
    assert.equal(core.snapshot().phase, 'selected');
    assert.equal(events.some(event => event.type === 'target-ready'), false);
    await core.reset();
  });
});

test('initial preparation does not permit planner evidence outside the enriched request', async () => {
  const { core, adapter } = setup();
  await assert.rejects(core.translate(planner(async request => {
    const result = resultFor(request); result.patch.evidenceRefs.push('fixture:unapproved-document'); return result;
  }), async request => ({ ...request, evidenceRefs: [...request.evidenceRefs, 'fixture:approved-document'] })), /UNKNOWN_EVIDENCE/);
  assert.deepEqual(adapter.calls, []);
  assert.equal(core.snapshot().phase, 'selected');
  await core.reset();
});

test('reset aborts pending preparation and a late attachment cannot plan or affect a new visitor', async () => {
  const { core, adapter, events, select } = setup();
  const gate = deferred<PlannerRequest>();
  let oldRequest!: PlannerRequest;
  let signal!: AbortSignal;
  let oldPlannerCalls = 0;
  const old = core.translate(planner(async request => { oldPlannerCalls++; return resultFor(request); }), async (request, contextSignal) => {
    oldRequest = request; signal = contextSignal; return gate.promise;
  });
  const rejected = assert.rejects(old, /OPERATOR_RESET/);
  await flush();
  await core.reset(); await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(oldPlannerCalls, 0);
  assert.equal(adapter.calls.includes('apply:start'), false);
  select(); await core.translate(planner());
  const snapshot = core.snapshot(), calls = [...adapter.calls], eventCount = events.length;
  gate.resolve({ ...oldRequest, instruction: 'Late data', evidenceRefs: [...oldRequest.evidenceRefs, 'fixture:late-document'] });
  await flush();
  assert.equal(oldPlannerCalls, 0);
  assert.deepEqual(core.snapshot(), snapshot);
  assert.deepEqual(adapter.calls, calls);
  assert.equal(events.length, eventCount);
  await core.reset();
});

test('the planner deadline also bounds preparation and late preparation cannot start the planner', async () => {
  const { core, adapter, events } = setup({ timeout: 10 });
  const gate = deferred<PlannerRequest>();
  let original!: PlannerRequest;
  let signal!: AbortSignal;
  let plannerCalls = 0;
  await assert.rejects(core.translate(planner(async request => { plannerCalls++; return resultFor(request); }), async (request, suppliedSignal) => {
    original = request; signal = suppliedSignal; return gate.promise;
  }), /PLANNER_TIMEOUT/);
  assert.equal(signal.aborted, true);
  assert.equal(plannerCalls, 0);
  assert.equal(core.snapshot().phase, 'selected');
  gate.resolve(original); await flush();
  assert.equal(plannerCalls, 0);
  assert.equal(adapter.calls.includes('apply:start'), false);
  assert.equal(events.some(event => event.type === 'target-ready'), false);
  await core.translate(planner());
  assert.equal(core.snapshot().phase, 'ready');
  await core.reset();
});

test('a synchronous planning reset prevents the preparation hook itself from running', async () => {
  let core!: SessionCoordinator;
  let reset: Promise<void> | undefined;
  let preparations = 0;
  const env = setup({ onEvent(event) { if (event.type === 'planning') reset = core.reset(); } });
  core = env.core;
  await assert.rejects(core.translate(planner(), async request => { preparations++; return request; }), /STALE_RESULT/);
  await reset;
  assert.equal(preparations, 0);
  assert.equal(env.adapter.calls.includes('apply:start'), false);
  assert.equal(core.snapshot().phase, 'idle');
});
