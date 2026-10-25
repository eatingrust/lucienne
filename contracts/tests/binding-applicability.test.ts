import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRequest, validatePatch, resolveBindingRequirements,
  type PlannerRequest, type NativePatch, type BindingApplicability, type BindingApplicabilityEntry } from '../index.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));
const request = () => validateRequest(fixture('planner-request'));
const patch = () => fixture('patch') as NativePatch;
const proof = 'host:scenario:binding-policy';
function scoped(input: PlannerRequest, entries?: BindingApplicabilityEntry[]): BindingApplicability {
  return { version: 1, scenarioId: input.scenarioId,
    source: { profileId: input.source.profileId, revision: input.source.revision, sourceApp: input.source.sourceApp },
    target: structuredClone(input.target),
    entries: entries ?? Object.keys(input.source.bindings).map(sourceAction => ({ sourceAction, status: 'mapped',
      capabilityId: input.catalog.find(c => c.bindingAction === sourceAction)!.id, relation: 'direct', evidenceRefs: [proof] })),
  };
}
function direct(): PlannerRequest {
  const input = request();
  input.evidenceRefs.push(proof);
  input.bindingApplicability = scoped(input);
  return input;
}
function withOmissions(): PlannerRequest {
  const input = direct();
  input.source.bindings.paint = 'B';
  input.source.bindings.zoom = 'Z';
  input.bindingApplicability!.entries.push(
    { sourceAction: 'paint', status: 'unavailable', reason: 'target-feature-absent', limitation: 'This target has no paint tool.', evidenceRefs: [proof] },
    { sourceAction: 'zoom', status: 'unchanged', reason: 'outside-selected-main-controls', limitation: 'Zoom keeps its native control outside this task.', evidenceRefs: [proof] },
  );
  return input;
}

test('absent applicability preserves legacy request acceptance and strict source-binding patch checks', () => {
  const input = request();
  assert.deepEqual(resolveBindingRequirements(input), {
    requiredOperations: [{ capabilityId: 'binding.pan', value: 'Space' }, { capabilityId: 'binding.select', value: 'V' }], limitations: [],
  });
  validatePatch(patch(), input);
  input.source.bindings.unsupported = 'Q';
  assert.doesNotThrow(() => validateRequest(input));
  assert.throws(() => validatePatch(patch(), input), /SOURCE_BINDING_NOT_PRESERVED/);
});

test('complete direct mapping derives unchanged original values and no notices', () => {
  const input = direct();
  const before = structuredClone(input.source);
  validateRequest(input);
  assert.deepEqual(resolveBindingRequirements(input), resolveBindingRequirements(request()));
  validatePatch(patch(), input);
  assert.deepEqual(input.source, before);
});

test('equivalent mapping uses actual target semantics but source binding still wins native defaults', () => {
  const input = direct();
  const binding = input.catalog.find(c => c.id === 'binding.pan')!;
  binding.bindingAction = 'orbit';
  binding.values = ['MiddleMouse', 'Space'];
  const entry = input.bindingApplicability!.entries.find(e => e.sourceAction === 'pan')!;
  assert.equal(entry.status, 'mapped');
  if (entry.status !== 'mapped') throw new Error('test fixture');
  assert.throws(() => validateRequest(input), /DIRECT_BINDING_SEMANTIC_MISMATCH/);
  entry.relation = 'equivalent';
  validateRequest(input);
  assert.equal(resolveBindingRequirements(input).requiredOperations.find(op => op.capabilityId === 'binding.pan')!.value, 'Space');
  validatePatch(patch(), input);
  const rewritten = patch(); rewritten.operations.find(op => op.capabilityId === 'binding.pan')!.value = 'MiddleMouse';
  assert.throws(() => validatePatch(rewritten, input), /SOURCE_BINDING_NOT_PRESERVED/);
});

test('every nonmapped action has a canonical mandatory notice; exact source profile survives', () => {
  const input = withOmissions();
  const original = structuredClone(input.source);
  const requirements = resolveBindingRequirements(input);
  assert.deepEqual(requirements.limitations, [
    'paint: This target has no paint tool.', 'zoom: Zoom keeps its native control outside this task.',
  ]);
  assert.throws(() => validatePatch(patch(), input), /BINDING_LIMITATION_REQUIRED/);
  const output = patch(); output.limitations = requirements.limitations;
  validatePatch(output, input);
  output.limitations.pop();
  assert.throws(() => validatePatch(output, input), /BINDING_LIMITATION_REQUIRED/);
  assert.deepEqual(input.source, original);
});

test('trusted mapped caveats survive validation and cannot be omitted or reworded', () => {
  const input = direct();
  const entry = input.bindingApplicability!.entries.find(e => e.sourceAction === 'pan')!;
  assert.equal(entry.status, 'mapped');
  if (entry.status !== 'mapped') throw new Error('test fixture');
  entry.relation = 'equivalent';
  input.catalog.find(c => c.id === entry.capabilityId)!.bindingAction = 'orbit';
  entry.limitation = 'Orbit rotates the view; it does not pan the image.';
  const accepted = validateRequest(input);
  const required = resolveBindingRequirements(accepted).limitations;
  assert.deepEqual(required, ['pan: Orbit rotates the view; it does not pan the image.']);
  assert.throws(() => validatePatch(patch(), accepted), /BINDING_LIMITATION_REQUIRED/);
  const output = patch(); output.limitations = required;
  validatePatch(output, accepted);
  output.limitations = ['pan: The controls are equivalent.'];
  assert.throws(() => validatePatch(output, accepted), /BINDING_LIMITATION_REQUIRED/);
});

test('mapped and nonmapped notices share the same hard budget without truncation', () => {
  const input = direct();
  const entry = input.bindingApplicability!.entries[0]!;
  if (entry.status !== 'mapped') throw new Error('test fixture');
  entry.limitation = 'Contextual limitation.';
  for (let n = 0; n < 12; n++) {
    const sourceAction = `extra${n}`;
    input.source.bindings[sourceAction] = 'Z';
    input.bindingApplicability!.entries.push({sourceAction, status:'unchanged', reason:'outside-selected-main-controls',
      limitation:'Retains the native control.', evidenceRefs:[proof]});
  }
  assert.throws(() => validateRequest(input), /TOO_MANY_BINDING_LIMITATIONS/);
  input.bindingApplicability!.entries.pop(); delete input.source.bindings.extra11;
  assert.equal(resolveBindingRequirements(validateRequest(input)).limitations.length, 12);
  entry.limitation = ' '.repeat(10);
  assert.throws(() => validateRequest(input), /INVALID_BINDING_LIMITATION/);
  entry.limitation = 'x'.repeat(600);
  assert.throws(() => validateRequest(input), /INVALID_BINDING_LIMITATION/);
});

const scopeMutations: Array<[string, (policy: BindingApplicability) => void]> = [
  ['scenario', p => { p.scenarioId = 'other-scenario'; }],
  ['profile identity', p => { p.source.profileId = 'other-profile'; }],
  ['profile revision', p => { p.source.revision = 'stale'; }],
  ['source app', p => { p.source.sourceApp = 'gimp'; }],
  ['target app', p => { p.target.appId = 'blender'; }],
  ['adapter version', p => { p.target.adapterVersion = 'old'; }],
];
for (const [name, mutate] of scopeMutations) test(`policy scope rejects mismatching ${name} before planning`, () => {
  const input = direct(); mutate(input.bindingApplicability!);
  assert.throws(() => validateRequest(input), /BINDING_APPLICABILITY_SCOPE_MISMATCH/);
});

test('missing, duplicate, foreign and unproven action policy entries fail closed', () => {
  const missing = direct(); missing.bindingApplicability!.entries.pop();
  assert.throws(() => validateRequest(missing), /INCOMPLETE_BINDING_APPLICABILITY/);
  const duplicate = direct(); duplicate.bindingApplicability!.entries.push(structuredClone(duplicate.bindingApplicability!.entries[0]!));
  assert.throws(() => validateRequest(duplicate), /DUPLICATE_BINDING_APPLICABILITY/);
  const foreign = direct(); foreign.bindingApplicability!.entries[0]!.sourceAction = 'invented';
  assert.throws(() => validateRequest(foreign), /UNKNOWN_SOURCE_BINDING/);
  const unproven = direct(); unproven.bindingApplicability!.entries[0]!.evidenceRefs = [];
  assert.throws(() => validateRequest(unproven));
  const unknown = direct(); unknown.bindingApplicability!.entries[0]!.evidenceRefs = ['invented:proof'];
  assert.throws(() => validateRequest(unknown), /UNTRUSTED_BINDING_APPLICABILITY_EVIDENCE/);
  const duplicatedProof = direct(); duplicatedProof.bindingApplicability!.entries[0]!.evidenceRefs = [proof, proof];
  assert.throws(() => validateRequest(duplicatedProof), /UNTRUSTED_BINDING_APPLICABILITY_EVIDENCE/);
});

test('source/model-only refs cannot authorize exemptions outside host request evidence', () => {
  const input = withOmissions();
  input.evidenceRefs = [proof];
  input.bindingApplicability!.entries.find(e => e.sourceAction === 'paint')!.evidenceRefs = [input.source.evidenceRefs[0]!];
  assert.throws(() => validateRequest(input), /UNTRUSTED_BINDING_APPLICABILITY_EVIDENCE/);
  const output = patch(); output.evidenceRefs = [proof, input.source.evidenceRefs[0]!];
  assert.throws(() => validatePatch(output, input), /UNTRUSTED_BINDING_APPLICABILITY_EVIDENCE/);
});

test('policy rejects duplicate target mappings, nonbinding capabilities and unsupported source values', () => {
  const duplicate = direct();
  duplicate.catalog.find(c => c.id === 'binding.pan')!.values.push('V');
  const selected = duplicate.bindingApplicability!.entries.find(e => e.sourceAction === 'select')!;
  if (selected.status !== 'mapped') throw new Error('test fixture');
  selected.capabilityId = 'binding.pan'; selected.relation = 'equivalent';
  assert.throws(() => validateRequest(duplicate), /DUPLICATE_BINDING_CAPABILITY_MAPPING/);
  const nonbinding = direct();
  const entry = nonbinding.bindingApplicability!.entries[0]!;
  if (entry.status !== 'mapped') throw new Error('test fixture');
  entry.capabilityId = 'panels.side';
  assert.throws(() => validateRequest(nonbinding), /INVALID_MAPPED_BINDING_CAPABILITY/);
  const unsupported = direct(); unsupported.source.bindings.pan = 'Q';
  assert.throws(() => validateRequest(unsupported), /SOURCE_BINDING_NOT_SUPPORTED/);
});

test('managed binding catalog must exactly match mappings; unavailable does not erase a managed control', () => {
  const input = direct();
  input.bindingApplicability!.entries[0] = { sourceAction: 'pan', status: 'unchanged', reason: 'outside-selected-main-controls', limitation: 'Pan is outside this task.', evidenceRefs: [proof] };
  assert.throws(() => validateRequest(input), /NONMAPPED_BINDING_STILL_MANAGED/);
  input.catalog = input.catalog.filter(c => c.id !== 'binding.pan');
  validateRequest(input);
  const output = patch(); output.operations = output.operations.filter(op => op.capabilityId !== 'binding.pan');
  output.limitations = resolveBindingRequirements(input).limitations;
  validatePatch(output, input);
  output.operations = output.operations.filter(op => op.capabilityId !== 'binding.select');
  assert.throws(() => validatePatch(output, input), /INCOMPLETE_PATCH/);
});

test('policy statuses, reasons, key values and native QA assertions cannot be injected', () => {
  const input = direct();
  const entry = input.bindingApplicability!.entries[0]!;
  for (const change of [
    { status: 'optional' }, { sourceValue: 'MiddleMouse' }, { nativeQA: 'pass' },
    { status: 'unavailable', reason: 'too-expensive', limitation: 'skip', capabilityId: undefined, relation: undefined },
  ]) {
    const raw = { ...input, bindingApplicability: { ...input.bindingApplicability!, entries: [{ ...entry, ...change }, input.bindingApplicability!.entries[1]!] } };
    assert.throws(() => validateRequest(raw));
  }
  assert.throws(() => validateRequest({ ...input, bindingApplicability: { ...input.bindingApplicability!, nativeQA: 'pass' } }));
});

test('a model patch cannot introduce or revise host policy to exempt a binding', () => {
  const input = direct();
  const output = patch(); output.operations.pop();
  assert.throws(() => validatePatch({ ...output, bindingApplicability: input.bindingApplicability }, input));
  assert.throws(() => validatePatch({ ...output, bindingExemptions: ['select'] }, input));
  assert.throws(() => validatePatch(output, input), /INCOMPLETE_PATCH/);
});

test('more than twelve nonmapped notices or oversized canonical text rejects without truncation', () => {
  const input = direct();
  for (let i = 0; i < 13; i++) {
    input.source.bindings[`other${i}`] = `Key${i}`;
    input.bindingApplicability!.entries.push({ sourceAction: `other${i}`, status: 'unchanged', reason: 'outside-selected-main-controls', limitation: 'Not selected.', evidenceRefs: [proof] });
  }
  assert.throws(() => validateRequest(input), /TOO_MANY_BINDING_LIMITATIONS/);
  const long = withOmissions();
  const nonmapped = long.bindingApplicability!.entries.find(e => e.status === 'unavailable')!;
  nonmapped.limitation = 'x'.repeat(600);
  assert.throws(() => validateRequest(long), /INVALID_BINDING_LIMITATION/);
});

test('chat remains intent-scoped and explicit preferences remain authoritative with a policy', () => {
  const input = direct();
  input.kind = 'chat'; input.intent = 'enlarge-work-area'; input.currentOperations = patch().operations;
  const output = patch(); output.operations.find(op => op.capabilityId === 'panels.side')!.value = 'right';
  assert.throws(() => validatePatch(output, input), /OUT_OF_SCOPE_CHAT_CHANGE/);
  input.kind = 'translate'; delete input.intent; input.currentOperations = [];
  input.explicit = [{ key: 'panel-side', value: 'right' }];
  assert.throws(() => validatePatch(patch(), input), /EXPLICIT_PREFERENCE_NOT_PRESERVED/);
});


test('standalone requirement resolution also enforces the approved route matrix', () => {
  const input = direct();
  input.target.appId = 'reaper';
  input.bindingApplicability!.target.appId = 'reaper';
  assert.throws(() => resolveBindingRequirements(input), /UNAPPROVED_ROUTE/);
});


for (const status of ['unavailable', 'unchanged'] as const) test(`a ${status} source action cannot be managed through another action's equivalent mapping`, () => {
  const input = direct();
  input.catalog = input.catalog.filter(capability => capability.id !== 'binding.select');
  input.catalog.find(capability => capability.id === 'binding.pan')!.values.push('V');
  input.bindingApplicability!.entries = [
    status === 'unavailable'
      ? { sourceAction: 'pan', status, reason: 'target-feature-absent', limitation: 'This target has no pan action.', evidenceRefs: [proof] }
      : { sourceAction: 'pan', status, reason: 'outside-selected-main-controls', limitation: 'Pan stays unchanged outside this task.', evidenceRefs: [proof] },
    { sourceAction: 'select', status: 'mapped', capabilityId: 'binding.pan', relation: 'equivalent', evidenceRefs: [proof] },
  ];
  const output = patch();
  output.operations = output.operations.filter(operation => operation.capabilityId !== 'binding.select');
  output.operations.find(operation => operation.capabilityId === 'binding.pan')!.value = 'V';
  output.limitations = [status === 'unavailable'
    ? 'pan: This target has no pan action.' : 'pan: Pan stays unchanged outside this task.'];
  assert.throws(() => validateRequest(input), /NONMAPPED_BINDING_STILL_MANAGED/);
  assert.throws(() => validatePatch(output, input), /NONMAPPED_BINDING_STILL_MANAGED/);
});
