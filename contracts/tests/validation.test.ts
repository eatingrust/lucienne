import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRequest, validatePatch, SourceProfileSchema, RunEventSchema, QAResultSchema, ROUTES, PlannerResultSchema } from '../index.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8'));

test('published profile, translate, chat, event and QA examples validate without native claims', () => {
  SourceProfileSchema.parse(fixture('profile'));
  const request = validateRequest(fixture('planner-request'));
  validatePatch(fixture('patch'), request);
  validatePatch(fixture('chat-patch'), validateRequest(fixture('chat-request')));
  PlannerResultSchema.parse(fixture('planner-result'));
  assert.equal(RunEventSchema.parse(fixture('run-event')).evidenceKind, 'fixture');
  assert.equal(QAResultSchema.parse(fixture('qa-result')).status, 'blocked');
  assert.equal(Object.keys(ROUTES).length, 6);
  assert.equal(Object.values(ROUTES).flat().length, 18);
});

test('unapproved route, stale identities, executable/extra fields, unsupported and duplicate operations fail', () => {
  const request = fixture('planner-request');
  assert.throws(() => validateRequest({ ...request, target: { appId: 'reaper', adapterVersion: '1' } }), /UNAPPROVED_ROUTE/);
  for (const field of ['runId', 'requestId', 'scenarioId']) {
    assert.throws(() => validatePatch({ ...fixture('patch'), [field]: 'stale' }, request), /WRONG_PATCH_IDENTITY/);
  }
  assert.throws(() => validatePatch({ ...fixture('patch'), script: 'malicious' }, request));
  const patch = fixture('patch');
  patch.operations[0].value = '/tmp/arbitrary';
  assert.throws(() => validatePatch(patch, request), /UNSUPPORTED_OPERATION/);
  const duplicate = fixture('patch'); duplicate.operations[1] = duplicate.operations[0];
  assert.throws(() => validatePatch(duplicate, request), /DUPLICATE_OPERATION/);
  assert.throws(() => validatePatch({ ...fixture('patch'), evidenceRefs: ['invented:source'] }, request), /UNKNOWN_EVIDENCE/);
});

test('explicit preferences and source bindings cannot be lost or overwritten', () => {
  const request = fixture('planner-request'); request.explicit = [{ key: 'panel-side', value: 'right' }];
  assert.throws(() => validatePatch(fixture('patch'), request), /EXPLICIT_PREFERENCE_NOT_PRESERVED/);
  const sourceExplicit = fixture('planner-request'); sourceExplicit.source.preferences[0] = { ...sourceExplicit.source.preferences[0], origin: 'explicit', value: 'right' };
  assert.throws(() => validatePatch(fixture('patch'), sourceExplicit), /EXPLICIT_PREFERENCE_NOT_PRESERVED/);
  const unsupported = fixture('planner-request'); unsupported.source.bindings.select = 'Z';
  assert.throws(() => validatePatch(fixture('patch'), unsupported), /SOURCE_BINDING_NOT_PRESERVED/);
  const missing = fixture('patch'); missing.operations.pop();
  assert.throws(() => validatePatch(missing, fixture('planner-request')), /INCOMPLETE_PATCH/);
});

test('chat patches require complete prior state and may change only their bounded intent', () => {
  const request = fixture('chat-request');
  assert.throws(() => validateRequest({ ...request, currentOperations: [] }), /INCOMPLETE_PATCH/);
  const patch = fixture('chat-patch'); patch.operations[0].value = 'right';
  assert.throws(() => validatePatch(patch, request), /OUT_OF_SCOPE_CHAT_CHANGE/);
});
