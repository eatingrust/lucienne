import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RunPresentationSchema, validateRequest, type PlannerRequest, type PlannerResult, type RunEvent } from '../../contracts/index.js';
import type { PlannerPort } from '../../contracts/ports.js';
import { makeFixture } from '../fixture.js';
import { publicRunPresentation, type PresentationContext } from '../presentation.js';
import { SessionCoordinator } from '../session.js';

const example = validateRequest(JSON.parse(readFileSync(new URL('../../contracts/examples/planner-request.json', import.meta.url), 'utf8')));
const privateText = 'PRIVATE_INPUT_MUST_NEVER_APPEAR';
function context(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return { type: 'planning', source: structuredClone(example.source), target: example.target.appId,
    mode: 'live', evidenceKind: 'native', catalog: structuredClone(example.catalog), explicit: [], operations: [], ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let index = 0; index < 30 && !predicate(); index++) await tick();
  assert.equal(predicate(), true, 'Expected lifecycle checkpoint was not reached');
}
function fixture(input: PlannerRequest = structuredClone(example)) {
  const f = makeFixture(input), events: RunEvent[] = [];
  let serial = 0;
  const core = new SessionCoordinator({ desktop: f.desktop, id: () => `presentation-run-${++serial}`,
    onEvent: event => { events.push(event); } });
  core.select(f.selection, f.adapter);
  return { ...f, core, events };
}
const displays = (events: RunEvent[]) => events.flatMap(event => event.presentation ? [event.presentation] : []);

test('planning copy uses only approved finite labels and never echoes unknown profile or capability text', () => {
  const input = context();
  input.source.label = privateText;
  input.source.profileId = privateText;
  input.source.bindings.pan = privateText;
  input.source.preferences.push({ key: 'private-preference', value: privateText, origin: 'explicit', evidenceRefs: ['private:path'] });
  input.catalog = [...input.catalog, { id: privateText, kind: 'canvas', preferenceKey: 'private-preference', values: [privateText] }];
  input.explicit = [{ key: 'private-preference', value: privateText }];
  const view = publicRunPresentation(input)!;
  assert.match(view.cards[0]!.body, /Krita.*Photoshop/);
  assert.match(view.cards[1]!.body, /Panels on the left/);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(privateText));
  assert.doesNotMatch(JSON.stringify(view), /private:path/);
  RunPresentationSchema.parse(view);
});

test('validated choices explain only matching explicit/profile preferences and unknown choices fall back to counts', () => {
  const input = context({ type: 'applying', explicit: [{ key: 'work-area', value: 'large' }], operations: [
    { capabilityId: 'panels.side', value: 'left' }, { capabilityId: 'work-area.size', value: 'large' },
    { capabilityId: 'tools.density', value: 'simple' }, { capabilityId: 'binding.pan', value: 'Space' },
    { capabilityId: 'binding.select', value: 'V' },
  ] });
  const view = publicRunPresentation(input)!;
  assert.match(view.cards[0]!.body, /Panels on the left; Larger work area; Simplified controls/);
  assert.match(view.cards[1]!.body, /Panel placement follows the selected profile/);
  assert.match(view.cards[1]!.body, /Work area follows an explicit preference/);
  assert.match(view.cards[1]!.body, /Tool density is a validated supported choice/);
  assert.match(view.cards[2]!.body, /plan includes 2 supported shortcut mappings/);
  assert.doesNotMatch(JSON.stringify(view), /verified|ready/);
  RunPresentationSchema.parse(view);
  const unknown = publicRunPresentation(context({ type: 'applying', catalog: [
    { id: privateText, kind: 'canvas', preferenceKey: privateText, values: [privateText] },
  ], operations: [{ capabilityId: privateText, value: privateText }] }))!;
  assert.match(unknown.cards[0]!.body, /1 supported control is included/);
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(privateText));
});

test('reset payloads are absent and failure/closing cards discard prior layout facts', () => {
  for (const type of ['reset-started', 'reset-completed'] as const) assert.equal(publicRunPresentation(context({ type })), undefined);
  for (const type of ['failed', 'closing'] as const) {
    const value = publicRunPresentation(context({ type }))!;
    assert.deepEqual(value.cards, []);
    assert.doesNotMatch(JSON.stringify(value), /Photoshop|Krita|left/);
  }
});

test('coordinator emits planned choices before apply and success only after matching readback, with no added events', async t => {
  const input = structuredClone(example); input.source.label = privateText;
  const f = fixture(input), readGate = deferred<void>();
  const originalReadback = f.adapter.readback;
  let reading = false;
  f.adapter.readback = async ctx => { reading = true; await readGate.promise; return originalReadback(ctx); };
  t.after(async () => { readGate.resolve(); await f.core.reset(); });
  const planner: PlannerPort = { ...f.planner, async plan(request, ctx) {
    const result = await f.planner.plan(request, ctx);
    result.patch.summary = privateText; result.patch.limitations = [privateText]; return result;
  } };
  const pending = f.core.translate(planner, async request => ({ ...request, instruction: privateText }));
  await until(() => reading);
  assert.deepEqual(f.events.map(event => event.type), ['selected', 'planning', 'progress', 'applying']);
  const applying = f.events.at(-1)!.presentation!;
  assert.equal(applying.cards[0]!.heading, 'Layout plan');
  assert.match(applying.cards[0]!.body, /Panels on the left/);
  assert.doesNotMatch(JSON.stringify(applying), /verified|ready/);
  readGate.resolve(); await pending;
  assert.deepEqual(f.events.map(event => event.type), ['selected', 'planning', 'progress', 'applying', 'target-ready']);
  assert.match(f.events.at(-1)!.presentation!.activity, /^Preview: Krita is ready/);
  assert.equal(f.events.at(-1)!.presentation!.cards[0]!.heading, 'Preview layout');
  for (const view of displays(f.events)) RunPresentationSchema.parse(view);
  assert.doesNotMatch(JSON.stringify(displays(f.events)), new RegExp(privateText));
  await f.core.reset();
  for (const event of f.events.filter(event => event.type.startsWith('reset-'))) assert.equal(Object.hasOwn(event, 'presentation'), false);
});

test('chat cards evolve from the actual validated explicit change after readback', async t => {
  const f = fixture(); t.after(() => f.core.reset());
  await f.core.translate(f.planner); f.core.openChat();
  await f.core.chat(f.planner, { intent: 'enlarge-work-area', instruction: privateText,
    explicit: [{ key: 'work-area', value: 'large' }] });
  const event = f.events.at(-1)!;
  assert.equal(event.type, 'chat-applied');
  assert.match(event.presentation!.cards[0]!.body, /Larger work area/);
  assert.match(event.presentation!.cards[1]!.body, /Work area follows an explicit preference/);
  assert.match(event.presentation!.activity, /adjustment is verified/);
  assert.doesNotMatch(JSON.stringify(displays(f.events)), new RegExp(privateText));
});

test('invalid plan and failed readback never publish a success card', async t => {
  for (const broken of ['plan', 'readback'] as const) {
    const f = fixture(); t.after(() => f.core.reset());
    const planner: PlannerPort = { ...f.planner, async plan(request, ctx) {
      const result = await f.planner.plan(request, ctx);
      if (broken === 'plan') result.patch.operations[0]!.value = privateText;
      return result;
    } };
    if (broken === 'readback') {
      const readback = f.adapter.readback;
      f.adapter.readback = async ctx => ({ ...await readback(ctx), interactive: false });
    }
    await assert.rejects(f.core.translate(planner));
    assert.equal(f.events.some(event => event.type === 'target-ready'), false);
    assert.equal(f.events.some(event => event.type === 'applying'), broken === 'readback');
    assert.deepEqual(f.events.find(event => event.type === 'failed')!.presentation!.cards, []);
    assert.doesNotMatch(JSON.stringify(displays(f.events)), /verified|is ready|PRIVATE_INPUT/);
  }
});

test('reset suppresses stale provider progress and a new run gets only its own selected preferences', async t => {
  const f = fixture(), started = deferred<void>(), gate = deferred<PlannerResult>();
  let staleProgress!: () => void, output!: PlannerResult;
  t.after(() => f.core.reset());
  const planner: PlannerPort = { ...f.planner, async plan(request, ctx) {
    staleProgress = ctx.onProgress; output = await f.planner.plan(request, ctx); started.resolve(); return gate.promise;
  } };
  const pending = f.core.translate(planner), rejected = assert.rejects(pending);
  await started.promise; await f.core.reset(); await rejected;
  const count = f.events.length;
  staleProgress(); gate.resolve(output); await tick();
  assert.equal(f.events.length, count);
  assert.equal(f.events.at(-1)!.type, 'reset-completed');
  assert.equal(f.events.at(-1)!.presentation, undefined);
  const next = structuredClone(f.selection);
  next.source.preferences[0]!.value = 'right';
  f.core.select(next, f.adapter);
  const selected = f.events.at(-1)!;
  assert.notEqual(selected.runId, f.events[0]!.runId);
  assert.match(selected.presentation!.cards[1]!.body, /Panels on the right/);
  assert.doesNotMatch(JSON.stringify(selected.presentation), /Panels on the left/);
});
