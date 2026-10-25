import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PAIRING_FILE_BYTES, PairingFileError, parsePairingFile } from '../src/pairing-file.ts';
import type { PairingFileProblem } from '../src/pairing-file.ts';

// Entirely synthetic; this capability is never sent to a service.
const token = 'a'.repeat(64);
const target = { uri: 'wss://example.invalid', databaseName: 'fixture-station' };
const now = 1_000;
const valid = { ...target, pairingToken: token, expiresAt: now + 1 };
const parse = (value: unknown) => parsePairingFile(JSON.stringify(value), target, now);
const problem = (code: PairingFileProblem) => (error: unknown) => {
  assert.ok(error instanceof PairingFileError);
  assert.equal(error.code, code);
  assert.equal(error.message, code, 'failure messages contain only a safe category');
  assert.doesNotMatch(JSON.stringify(error), new RegExp(token));
  return true;
};

test('accepts the exact main-owned shape and returns only its capability', () => {
  assert.equal(parse(valid), token);
  assert.equal(parsePairingFile(JSON.stringify(valid, null, 2), target, now), token);
  assert.deepEqual(target, { uri: 'wss://example.invalid', databaseName: 'fixture-station' });
});

test('rejects expiry at or before the current instant, including after a delayed file read', () => {
  for (const expiresAt of [now - 1, now]) assert.throws(() => parse({ ...valid, expiresAt }), problem('expired-file'));
  assert.throws(() => parsePairingFile(JSON.stringify(valid), target, now + 2), problem('expired-file'));
  assert.throws(() => parsePairingFile(JSON.stringify(valid), target, Number.NaN), problem('expired-file'));
});

test('rejects another endpoint or database without selecting a new transport', () => {
  for (const uri of ['wss://another.invalid', target.uri + '/', target.uri + '?token=' + token,
    'https://example.invalid', 'wss://EXAMPLE.invalid', 'wss://example.invalid:443']) {
    assert.throws(() => parse({ ...valid, uri }), problem('wrong-station'));
  }
  assert.throws(() => parse({ ...valid, databaseName: 'another-station' }), problem('wrong-station'));
});

test('rejects malformed JSON and non-object values without echoing file contents', () => {
  assert.throws(() => parsePairingFile('{"private":"' + token, target, now), problem('invalid-file'));
  for (const value of [null, [], true, 123, token]) assert.throws(() => parse(value), problem('invalid-file'));
});

test('rejects missing or additional fields, including private producer credentials', () => {
  for (const key of Object.keys(valid)) {
    const value: Record<string, unknown> = { ...valid };
    delete value[key];
    assert.throws(() => parse(value), problem('invalid-file'));
  }
  assert.throws(() => parse({ ...valid, producerToken: 'private-fixture-producer' }), problem('invalid-file'));
  assert.throws(() => parse({ ...valid, version: 1 }), problem('invalid-file'));
});

test('enforces field types, bounds, and the exact lowercase capability format', () => {
  for (const uri of [null, 123, '', 'w'.repeat(2049)]) assert.throws(() => parse({ ...valid, uri }), problem('invalid-file'));
  for (const databaseName of [null, 123, '', 'd'.repeat(129)]) assert.throws(() => parse({ ...valid, databaseName }), problem('invalid-file'));
  for (const pairingToken of [null, 123, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' ' + token]) {
    assert.throws(() => parse({ ...valid, pairingToken }), problem('invalid-file'));
  }
  for (const expiresAt of [null, '1001', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse({ ...valid, expiresAt }), problem('invalid-file'));
  }
});

test('accepts exactly the byte limit and rejects one byte over it', () => {
  const json = JSON.stringify(valid);
  const bounded = json + ' '.repeat(MAX_PAIRING_FILE_BYTES - Buffer.byteLength(json));
  assert.equal(parsePairingFile(bounded, target, now), token);
  assert.throws(() => parsePairingFile(bounded + ' ', target, now), problem('invalid-file'));
});

test('counts UTF-8 bytes rather than JavaScript string length', () => {
  const unicodeTarget = { uri: 'wss://' + '😀'.repeat(1_010), databaseName: '😀'.repeat(60) };
  const json = JSON.stringify({ ...valid, ...unicodeTarget });
  const padded = json + ' '.repeat(MAX_PAIRING_FILE_BYTES - Buffer.byteLength(json) + 1);
  assert.ok(padded.length < MAX_PAIRING_FILE_BYTES);
  assert.equal(Buffer.byteLength(padded), MAX_PAIRING_FILE_BYTES + 1);
  assert.throws(() => parsePairingFile(padded, unicodeTarget, now), problem('invalid-file'));
});
