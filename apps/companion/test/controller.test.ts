import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionView } from '@lucienne/session/companion';
import { createCompanionController, type CompanionPorts, type PrivateStorage } from '../src/controller.js';
import { fixtureCode, fixtureEvent } from '../src/fixture.js';

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: PrivateStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
  };
  return { storage, values };
}
function harness(pair?: CompanionPorts['pairing']['call']) {
  const attempts: { pairingToken: string; readerToken: string }[] = [];
  const subscriptions: { readerToken: string; update: (view: SessionView) => void; error: () => void; stops: number }[] = [];
  const ports: CompanionPorts = {
    pairing: { async call(name, args) {
      attempts.push({ ...args });
      return pair ? pair(name, args) : { streamId: 'fixture-stream', expiresAt: Date.now() + 60_000 };
    } },
    subscription: { subscribe(args, update, error) {
      const subscription = { readerToken: args.readerToken, update, error, stops: 0 };
      subscriptions.push(subscription);
      return () => { subscription.stops++; };
    } },
  };
  return { ports, attempts, subscriptions };
}
function view(cursor: number, type: Parameters<typeof fixtureEvent>[0], options: Partial<SessionView> = {}): SessionView {
  return { streamId: 'fixture-stream', serverAt: Date.now(), readerExpiresAt: Date.now() + 60_000,
    cursor, oldestCursor: 1, gap: false, events: [{ cursor, event: fixtureEvent(type, cursor) }], ...options };
}

test('uncertain pairing retains reader identity across retry and reload, then resumes without redeeming again', async t => {
  const memory = memoryStorage();
  let fail = true;
  const io = harness(async () => {
    if (fail) throw new Error('private transport detail with credential');
    return { streamId: 'fixture-stream', expiresAt: Date.now() + 60_000 };
  });
  const first = createCompanionController(io.ports, memory.storage);
  t.after(() => first.dispose());
  await first.pair(fixtureCode);
  assert.equal(first.getSnapshot().retryPairing, true);
  assert.equal(first.getSnapshot().problem, 'pairing');
  assert.doesNotMatch(JSON.stringify(first.getSnapshot()), /private transport|credential/);
  await first.retryPairing();
  assert.deepEqual(io.attempts[1], io.attempts[0]);
  first.dispose();

  const reloaded = createCompanionController(io.ports, memory.storage);
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.getSnapshot().retryPairing, true);
  assert.equal(io.attempts.length, 2, 'reload does not automatically redeem a pending capability');
  fail = false;
  await reloaded.retryPairing();
  assert.deepEqual(io.attempts[2], io.attempts[0]);
  assert.equal(io.subscriptions[0]?.readerToken, io.attempts[0]?.readerToken);
  assert.equal(reloaded.getSnapshot().status, 'connecting');
  const persisted = JSON.parse([...memory.values.values()][0]!);
  assert.deepEqual(Object.keys(persisted).sort(), ['readerToken', 'version']);
  reloaded.dispose();

  const connectedReload = createCompanionController(io.ports, memory.storage);
  t.after(() => connectedReload.dispose());
  assert.equal(io.attempts.length, 3);
  assert.equal(io.subscriptions[1]?.readerToken, io.attempts[0]?.readerToken);
});

for (const action of ['forget', 'dispose'] as const) {
  test(`late successful pairing after ${action} cannot attach a subscription or overwrite private storage`, async () => {
    let resolve!: (value: { streamId: string; expiresAt: number }) => void;
    const io = harness(() => new Promise(done => { resolve = done; }));
    const memory = memoryStorage();
    const controller = createCompanionController(io.ports, memory.storage);
    const pairing = controller.pair(fixtureCode);
    controller[action]();
    const storageAtLeave = [...memory.values.entries()];
    resolve({ streamId: 'late-fixture-stream', expiresAt: Date.now() + 60_000 });
    await pairing;
    assert.equal(io.subscriptions.length, 0);
    assert.deepEqual([...memory.values.entries()], storageAtLeave);
    if (action === 'forget') assert.equal(controller.getSnapshot().status, 'pairing');
    controller.dispose();
  });
}

test('invalid input and failed private persistence never send pairing requests', async () => {
  const io = harness();
  const controller = createCompanionController(io.ports, {
    getItem: () => null, setItem: () => { throw new Error('private storage detail'); }, removeItem: () => {},
  });
  await controller.pair('not-a-capability');
  assert.equal(controller.getSnapshot().problem, 'invalid-code');
  await controller.pair(fixtureCode);
  assert.equal(controller.getSnapshot().problem, 'storage');
  assert.equal(io.attempts.length, 0);
  assert.doesNotMatch(JSON.stringify(controller.getSnapshot()), /private storage detail/);
  controller.dispose();
});

test('invalid replacement input keeps an uncertain saved pairing retry available', async () => {
  const io = harness(async () => { throw new Error('uncertain fixture response'); });
  const controller = createCompanionController(io.ports);
  await controller.pair(fixtureCode);
  assert.equal(controller.getSnapshot().retryPairing, true);
  await controller.pair('incomplete-new-code');
  assert.equal(controller.getSnapshot().problem, 'invalid-code');
  assert.equal(controller.getSnapshot().retryPairing, true, 'invalid input must not hide the retained uncertain attempt');
  await controller.retryPairing();
  assert.deepEqual(io.attempts[1], io.attempts[0]);
  controller.dispose();
});

test('storage failure after remote redemption keeps the exact pair available for retry', async t => {
  const memory = memoryStorage(), io = harness();
  let writes = 0;
  const controller = createCompanionController(io.ports, {
    ...memory.storage, setItem(key, value) {
      writes++;
      if (writes === 2) throw new Error('fixture storage failure after ACK');
      memory.storage.setItem(key, value);
    },
  });
  t.after(() => controller.dispose());
  await controller.pair(fixtureCode);
  assert.equal(controller.getSnapshot().problem, 'storage');
  assert.equal(controller.getSnapshot().retryPairing, true);
  assert.equal(io.subscriptions.length, 0);
  await controller.retryPairing();
  assert.deepEqual(io.attempts[1], io.attempts[0]);
  assert.equal(controller.getSnapshot().status, 'connecting');
  assert.equal(io.subscriptions.length, 1);
});

test('gap/initial snapshots do not replay and disconnected states cannot retain visitor details', async t => {
  const io = harness();
  const controller = createCompanionController(io.ports);
  t.after(() => controller.dispose());
  await controller.pair(fixtureCode);
  const connection = io.subscriptions[0]!;
  connection.update(view(1, 'target-ready'));
  assert.equal(controller.getSnapshot().status, 'live');
  assert.equal(controller.getSnapshot().session?.latest?.type, 'target-ready');
  assert.deepEqual(controller.getSnapshot().session?.events, [], 'initial snapshot is not transition replay');

  connection.update(view(7, 'chat-applied', { oldestCursor: 7, gap: true }));
  assert.equal(controller.getSnapshot().session?.gap, true);
  assert.equal(controller.getSnapshot().session?.latest?.type, 'chat-applied');
  assert.deepEqual(controller.getSnapshot().session?.events, []);

  connection.update(view(8, 'reset-started', { oldestCursor: 8 }));
  assert.equal(controller.getSnapshot().session?.latest?.type, 'reset-started');
  connection.update(view(9, 'reset-completed', { oldestCursor: 9 }));
  assert.equal(controller.getSnapshot().session?.latest?.type, 'reset-completed');

  connection.update(view(10, 'target-ready', { serverAt: Date.now() - 31_000 }));
  assert.equal(controller.getSnapshot().status, 'stale');
  assert.equal(controller.getSnapshot().session?.latest, null);
  assert.deepEqual(controller.getSnapshot().session?.events, []);
  connection.error();
  assert.equal(controller.getSnapshot().status, 'error');
  assert.equal(controller.getSnapshot().session?.latest, null);
  assert.equal(controller.getSnapshot().reconnect, true);

  controller.reconnect();
  assert.equal(connection.stops, 1);
  assert.equal(io.subscriptions[1]?.readerToken, connection.readerToken);
  connection.update(view(11, 'target-ready'));
  assert.equal(controller.getSnapshot().status, 'connecting', 'detached transport cannot repopulate the display');
  io.subscriptions[1]!.update(view(12, 'target-ready', { readerExpiresAt: Date.now() - 1 }));
  assert.equal(controller.getSnapshot().status, 'expired');
  assert.equal(controller.getSnapshot().session?.latest, null);
  controller.dispose();
  controller.dispose();
  assert.equal(io.subscriptions[1]?.stops, 1);
});

test('forget clears persistence and suppresses late subscription callbacks', async () => {
  const memory = memoryStorage(), io = harness();
  const controller = createCompanionController(io.ports, memory.storage);
  await controller.pair(fixtureCode);
  const subscription = io.subscriptions[0]!;
  subscription.update(view(1, 'target-ready'));
  controller.forget();
  subscription.update(view(2, 'chat-applied'));
  subscription.error();
  assert.equal(controller.getSnapshot().status, 'pairing');
  assert.equal(controller.getSnapshot().session, null);
  assert.equal(memory.values.size, 0);
  assert.equal(subscription.stops, 1);
  controller.dispose();
});
