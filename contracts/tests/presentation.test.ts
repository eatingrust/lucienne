import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RunEventSchema, RunPresentationSchema } from '../index.js';

const event = JSON.parse(readFileSync(new URL('../examples/run-event.json', import.meta.url), 'utf8'));
const presentation = { version: 1, cards: [{ heading: 'Layout plan', body: 'Panels on the right.' }], activity: 'Applying the validated workspace plan.' };

test('public presentation is optional for existing events and retains a complete bounded snapshot', () => {
  assert.equal(RunEventSchema.parse(event).presentation, undefined);
  assert.deepEqual(RunEventSchema.parse({ ...event, presentation }).presentation, presentation);
  assert.deepEqual(RunPresentationSchema.parse({ version: 1, cards: [], activity: 'The action failed.' }).cards, []);
  RunPresentationSchema.parse({ version: 1, cards: Array.from({ length: 3 }, () => ({ heading: 'h'.repeat(80), body: 'b'.repeat(240) })), activity: 'a'.repeat(240) });
});

test('presentation rejects oversized, empty and unknown nested fields', () => {
  for (const value of [
    { ...presentation, version: 2 },
    { ...presentation, cards: Array.from({ length: 4 }, () => presentation.cards[0]) },
    { ...presentation, activity: '' },
    { ...presentation, activity: 'a'.repeat(241) },
    { ...presentation, cards: [{ heading: '', body: 'Valid' }] },
    { ...presentation, cards: [{ heading: 'h'.repeat(81), body: 'Valid' }] },
    { ...presentation, cards: [{ heading: 'Valid', body: '' }] },
    { ...presentation, cards: [{ heading: 'Valid', body: 'b'.repeat(241) }] },
    { ...presentation, cards: [{ ...presentation.cards[0], reasoning: 'Private text' }] },
    { ...presentation, prompt: 'Private text' },
  ]) assert.equal(RunEventSchema.safeParse({ ...event, presentation: value }).success, false);
});
