import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SessionCoordinator, type Selection } from '../session.js';
import { makeFixture } from '../fixture.js';
import { validateRequest, resolveBindingRequirements, type PlannerRequest, type BindingApplicability } from '../../contracts/index.js';
import type { NativeAdapter, PlannerPort } from '../../contracts/ports.js';

const example = (): PlannerRequest => validateRequest(JSON.parse(readFileSync(new URL('../../contracts/examples/planner-request.json', import.meta.url), 'utf8')));
const proof = 'host:scenario:binding-policy';
function configured() {
  const request = example();
  request.source.bindings.paint = 'B';
  request.evidenceRefs = [proof];
  request.catalog.find(c => c.id === 'binding.pan')!.bindingAction = 'orbit';
  request.bindingApplicability = {
    version: 1, scenarioId: request.scenarioId,
    source: { profileId: request.source.profileId, revision: request.source.revision, sourceApp: request.source.sourceApp },
    target: structuredClone(request.target), entries: [
      { sourceAction: 'pan', status: 'mapped', capabilityId: 'binding.pan', relation: 'equivalent', evidenceRefs: [proof] },
      { sourceAction: 'select', status: 'mapped', capabilityId: 'binding.select', relation: 'direct', evidenceRefs: [proof] },
      { sourceAction: 'paint', status: 'unavailable', reason: 'target-feature-absent', limitation: 'This target has no paint tool.', evidenceRefs: [proof] },
    ],
  };
  return request;
}
function setup() {
  const request = configured();
  const fixture = makeFixture(request);
  const selection: Selection = { ...fixture.selection, bindingApplicability: structuredClone(request.bindingApplicability!), evidenceRefs: [...request.evidenceRefs] };
  const calls: PlannerRequest[] = [];
  let applies = 0;
  const adapter: NativeAdapter = { ...fixture.adapter, async apply(...args) { applies++; return fixture.adapter.apply(...args); } };
  const core = new SessionCoordinator({ desktop: fixture.desktop });
  const planner: PlannerPort = { ...fixture.planner, async plan(input, context) {
    calls.push(structuredClone(input));
    const output = await fixture.planner.plan(input, context);
    const requirements = resolveBindingRequirements(input);
    const bindings = new Map(requirements.requiredOperations.map(operation => [operation.capabilityId, operation.value]));
    output.patch.operations = output.patch.operations.map(operation => ({ ...operation, value: bindings.get(operation.capabilityId) ?? operation.value }));
    output.patch.limitations.push(...requirements.limitations);
    return output;
  } };
  return { core, request, selection, adapter, planner, calls, get applies() { return applies; } };
}

test('host policy, host evidence, and full source propagate unchanged through initial and chat requests', async () => {
  const env = setup();
  const source = structuredClone(env.selection.source);
  const policy = structuredClone(env.selection.bindingApplicability);
  env.core.select(env.selection, env.adapter);
  env.selection.source.bindings.paint = 'rewritten-outside-core';
  env.selection.bindingApplicability!.source.revision = 'stale-outside-core';
  env.selection.evidenceRefs![0] = 'untrusted-outside-core';
  await env.core.translate(env.planner);
  env.core.openChat();
  await env.core.chat(env.planner, { intent: 'enlarge-work-area', instruction: 'Enlarge', explicit: [{ key: 'work-area', value: 'large' }] });
  assert.equal(env.calls.length, 2);
  for (const request of env.calls) {
    assert.deepEqual(request.source, source);
    assert.deepEqual(request.bindingApplicability, policy);
    assert.deepEqual(request.evidenceRefs, [proof]);
    assert.equal(request.source.bindings.pan, 'Space');
    assert.equal(request.source.bindings.paint, 'B');
  }
  assert.equal(env.applies, 2);
  assert.equal(env.core.snapshot().phase, 'ready');
  await env.core.reset();
  assert.equal(env.core.snapshot().phase, 'idle');
  const legacy = makeFixture(example());
  env.core.select(legacy.selection, legacy.adapter);
  await env.core.translate(legacy.planner);
  assert.equal(env.core.snapshot().phase, 'ready');
  await env.core.reset();
});

test('policy requires explicitly supplied host evidence rather than a source-profile fallback', () => {
  const env = setup();
  delete env.selection.evidenceRefs;
  env.selection.bindingApplicability!.entries.forEach(entry => { entry.evidenceRefs = [...env.selection.source.evidenceRefs]; });
  assert.throws(() => env.core.select(env.selection, env.adapter), /BINDING_APPLICABILITY_EVIDENCE_REQUIRED/);
  assert.equal(env.core.snapshot().phase, 'idle');
  assert.equal(env.calls.length, 0);
  assert.equal(env.applies, 0);
});

const invalidPolicies: Array<[string, (policy: BindingApplicability) => void, RegExp]> = [
  ['missing source action', p => { p.entries.pop(); }, /INCOMPLETE_BINDING_APPLICABILITY/],
  ['stale revision', p => { p.source.revision = 'old'; }, /BINDING_APPLICABILITY_SCOPE_MISMATCH/],
  ['untrusted proof', p => { p.entries[0]!.evidenceRefs = ['model:invented']; }, /UNTRUSTED_BINDING_APPLICABILITY_EVIDENCE/],
];
for (const [name, mutate, error] of invalidPolicies) test(`selection rejects ${name} before provider execution or visitor state`, () => {
  const env = setup(); mutate(env.selection.bindingApplicability!);
  assert.throws(() => env.core.select(env.selection, env.adapter), error);
  assert.equal(env.calls.length, 0);
  assert.equal(env.applies, 0);
  assert.equal(env.core.snapshot().phase, 'idle');
});

test('a planner cannot mutate its request copy to exempt an originally managed binding', async () => {
  const env = setup();
  env.core.select(env.selection, env.adapter);
  const malicious: PlannerPort = { ...env.planner, async plan(input, context) {
    const output = await env.planner.plan(input, context);
    input.bindingApplicability!.entries = input.bindingApplicability!.entries.map(entry => entry.sourceAction === 'pan' ?
      { sourceAction: 'pan', status: 'unavailable', reason: 'target-feature-absent', limitation: 'The model wants to skip this.', evidenceRefs: [proof] } : entry);
    output.patch.operations = output.patch.operations.filter(operation => operation.capabilityId !== 'binding.pan');
    return output;
  } };
  await assert.rejects(env.core.translate(malicious), /INCOMPLETE_PATCH/);
  assert.equal(env.applies, 0);
  assert.equal(env.core.snapshot().phase, 'selected');
  await env.core.translate(env.planner);
  assert.equal(env.core.snapshot().phase, 'ready');
  assert.equal(env.calls.at(-1)!.bindingApplicability!.entries.find(entry => entry.sourceAction === 'pan')!.status, 'mapped');
  await env.core.reset();
});

test('omitted mandatory limitation rejects before native apply and preserves retry', async () => {
  const env = setup();
  env.core.select(env.selection, env.adapter);
  const omitting: PlannerPort = { ...env.planner, async plan(input, context) {
    const output = await env.planner.plan(input, context);
    output.patch.limitations = [];
    return output;
  } };
  await assert.rejects(env.core.translate(omitting), /BINDING_LIMITATION_REQUIRED/);
  assert.equal(env.applies, 0);
  assert.equal(env.core.snapshot().phase, 'selected');
  await env.core.translate(env.planner);
  assert.equal(env.applies, 1);
  await env.core.reset();
});
