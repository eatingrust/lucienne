import { schema, table, t, SenderError, ScheduleAt, type Infer, type InferSchema, type ReducerCtx } from 'spacetimedb/server';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { appendBatch, type Delivery, type SessionView } from '../../../src/projection.js';
import { assertToken, assertStreamId, PAIRING_TTL_MS, READER_TTL_MS, SessionError } from '../../../src/capabilities.js';

// Only identity-filtered projections are public. No raw capability is persisted.
const configuration = table({ name: 'configuration' }, {
  key: t.string().primaryKey(), owner: t.identity(), producerHash: t.string(),
  pairingTtlMs: t.u32(), readerTtlMs: t.u32(),
});
const station = table({ name: 'station' }, {
  key: t.string().primaryKey(), streamId: t.string(), cursor: t.f64(),
  eventsJson: t.string(), serverAt: t.f64(),
  pairingHash: t.string().optional(), pairingExpiresAt: t.f64().optional(),
  consumedPairingHash: t.string().optional(), readerHash: t.string().optional(),
  readerIdentity: t.identity().optional(), readerExpiresAt: t.f64().optional(), readerAfter: t.f64(),
});
// Two fixed slots keep durable responses bounded even if callers change identity.
const acknowledgements = table({ name: 'acknowledgements' }, {
  slot: t.u8().primaryKey(), sender: t.identity(), at: t.u64(),
  requestId: t.string(), resultJson: t.string(), errorCode: t.string(),
});
const readerExpiry = table({ name: 'reader_expiry' }, {
  scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt(),
  streamId: t.string(), readerHash: t.string(), expiresAt: t.f64(),
});
const spacetime = schema({ configuration, station, acknowledgements, readerExpiry });
export default spacetime;
type Context = ReducerCtx<InferSchema<typeof spacetime>>;
type Station = Infer<typeof station.rowType>;

function now(ctx: Context): number { return Number(ctx.timestamp.microsSinceUnixEpoch / 1000n); }
function hash(token: unknown): string {
  assertToken(token);
  return bytesToHex(sha256(new TextEncoder().encode(token)));
}
function sameHash(actual: string, expected: string | undefined): boolean {
  if (!expected || actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
function getConfig(ctx: Context) {
  const config = ctx.db.configuration.key.find('main');
  if (!config) throw new SessionError('UNAUTHORIZED');
  return config;
}
function authorizeProducer(ctx: Context, args: Record<string, unknown>) {
  const config = getConfig(ctx);
  if (!sameHash(hash(args.producerToken), config.producerHash)) throw new SessionError('UNAUTHORIZED');
  return config;
}
function getProducerStation(ctx: Context, args: Record<string, unknown>): Station {
  authorizeProducer(ctx, args);
  assertStreamId(args.streamId as string);
  const row = ctx.db.station.key.find('main');
  if (!row || row.streamId !== args.streamId) throw new SessionError('STALE_STREAM');
  return row;
}
function clearExpiry(ctx: Context) {
  for (const row of ctx.db.readerExpiry.iter()) ctx.db.readerExpiry.scheduledId.delete(row.scheduledId);
}
function withoutReader(row: Station): Station {
  return { ...row, readerHash: undefined, readerIdentity: undefined, readerExpiresAt: undefined,
    consumedPairingHash: undefined, pairingHash: undefined, pairingExpiresAt: undefined, readerAfter: 0 };
}
function view(row: Station, after: number): SessionView {
  const events = JSON.parse(row.eventsJson) as Delivery[];
  const oldestCursor = events[0]?.cursor ?? row.cursor + 1;
  return { streamId: row.streamId, cursor: row.cursor, events, serverAt: row.serverAt,
    readerExpiresAt: row.readerExpiresAt!, oldestCursor, gap: after < oldestCursor - 1 };
}
function clearReader(ctx: Context, row: Station, preservePairing = false) {
  const next = withoutReader(row);
  if (preservePairing) {
    next.pairingHash = row.pairingHash;
    next.pairingExpiresAt = row.pairingExpiresAt;
  }
  ctx.db.station.key.update(next);
  ctx.db.acknowledgements.slot.delete(1);
  clearExpiry(ctx);
}
function ack(ctx: Context, slot: number, requestId: string, result: unknown) {
  const next = { slot, sender: ctx.sender, at: ctx.timestamp.microsSinceUnixEpoch,
    requestId, resultJson: JSON.stringify(result), errorCode: '' };
  if (ctx.db.acknowledgements.slot.find(slot)) ctx.db.acknowledgements.slot.update(next);
  else ctx.db.acknowledgements.insert(next);
}

export const init = spacetime.init(ctx => {
  ctx.db.configuration.insert({ key: 'main', owner: ctx.sender, producerHash: '',
    pairingTtlMs: PAIRING_TTL_MS, readerTtlMs: READER_TTL_MS });
});

// Destructive reconfiguration is restricted to the publisher identity. Reduced
// TTLs are for isolated parity databases; default values are 300000/43200000 ms.
export const configure = spacetime.reducer({
  producerHash: t.string(), pairingTtlMs: t.u32(), readerTtlMs: t.u32(),
}, (ctx, args) => {
  const config = getConfig(ctx);
  if (!ctx.sender.isEqual(config.owner)) throw new SenderError('UNAUTHORIZED');
  if (!/^[a-f0-9]{64}$/.test(args.producerHash) || args.pairingTtlMs < 1 ||
      args.pairingTtlMs > PAIRING_TTL_MS || args.readerTtlMs < 1 || args.readerTtlMs > READER_TTL_MS) {
    throw new SenderError('INVALID_ARGUMENT');
  }
  ctx.db.configuration.key.update({ ...config, ...args });
  ctx.db.station.key.delete('main');
  ctx.db.acknowledgements.slot.delete(0);
  ctx.db.acknowledgements.slot.delete(1);
  clearExpiry(ctx);
});

export const expireReader = spacetime.reducer({ onSchedule: readerExpiry }, {
  expiry: readerExpiry.rowType,
}, (ctx, { expiry }) => {
  // The host is the sole caller allowed to run a scheduled invalidation.
  if (!ctx.sender.isEqual(ctx.identity)) throw new SenderError('UNAUTHORIZED');
  const row = ctx.db.station.key.find('main');
  if (row && row.streamId === expiry.streamId && row.readerHash === expiry.readerHash &&
      row.readerExpiresAt === expiry.expiresAt && expiry.expiresAt <= now(ctx)) clearReader(ctx, row, true);
});

function execute(ctx: Context, op: string, args: Record<string, unknown>): { slot: number; result: unknown } {
  const time = now(ctx);
  if (op === 'inspectProducer') {
    authorizeProducer(ctx, args);
    return { slot: 0, result: { streamId: ctx.db.station.key.find('main')?.streamId ?? null } };
  }
  if (op === 'open') {
    authorizeProducer(ctx, args);
    assertStreamId(args.streamId as string);
    if (args.expectedStreamId !== null) assertStreamId(args.expectedStreamId as string);
    const row = ctx.db.station.key.find('main');
    if (row && row.streamId === args.streamId) return { slot: 0, result: { streamId: row.streamId, cursor: row.cursor } };
    if ((row?.streamId ?? null) !== args.expectedStreamId) throw new SessionError('STALE_STREAM');
    const next: Station = { key: 'main', streamId: args.streamId as string, cursor: 0, eventsJson: '[]',
      serverAt: time, readerAfter: 0, pairingHash: undefined, pairingExpiresAt: undefined,
      consumedPairingHash: undefined, readerHash: undefined, readerIdentity: undefined, readerExpiresAt: undefined };
    if (row) ctx.db.station.key.update(next); else ctx.db.station.insert(next);
    ctx.db.acknowledgements.slot.delete(1);
    clearExpiry(ctx);
    return { slot: 0, result: { streamId: next.streamId, cursor: 0 } };
  }
  if (op === 'pair') {
    const row = ctx.db.station.key.find('main');
    const pairingHash = hash(args.pairingToken), readerHash = hash(args.readerToken);
    if (row && sameHash(pairingHash, row.consumedPairingHash) && sameHash(readerHash, row.readerHash) &&
        row.readerIdentity?.isEqual(ctx.sender) && row.readerExpiresAt! > time) {
      return { slot: 1, result: { streamId: row.streamId, expiresAt: row.readerExpiresAt } };
    }
    if (!row || !sameHash(pairingHash, row.pairingHash)) throw new SessionError('UNAUTHORIZED');
    if (row.pairingExpiresAt! <= time) throw new SessionError('PAIRING_EXPIRED');
    const expiresAt = time + getConfig(ctx).readerTtlMs;
    ctx.db.station.key.update({ ...row, readerHash, readerIdentity: ctx.sender, readerExpiresAt: expiresAt,
      consumedPairingHash: pairingHash, pairingHash: undefined, pairingExpiresAt: undefined, readerAfter: 0 });
    clearExpiry(ctx);
    ctx.db.readerExpiry.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.time(BigInt(expiresAt) * 1000n),
      streamId: row.streamId, readerHash, expiresAt });
    return { slot: 1, result: { streamId: row.streamId, expiresAt } };
  }
  if (op === 'read') {
    if (!Number.isSafeInteger(args.after) || (args.after as number) < 0) throw new SessionError('INVALID_ARGUMENT');
    const row = ctx.db.station.key.find('main');
    const readerHash = hash(args.readerToken);
    if (!row || !sameHash(readerHash, row.readerHash) || !row.readerIdentity?.isEqual(ctx.sender) ||
        row.readerExpiresAt! <= time) throw new SessionError('UNAUTHORIZED');
    const next = { ...row, readerAfter: args.after as number };
    ctx.db.station.key.update(next);
    return { slot: 1, result: view(next, next.readerAfter) };
  }
  if (!['publish', 'heartbeat', 'issuePairing', 'revokeReader'].includes(op)) throw new SessionError('INVALID_ARGUMENT');
  const row = getProducerStation(ctx, args);
  if (op === 'publish') {
    const next = appendBatch({ cursor: row.cursor, events: JSON.parse(row.eventsJson) }, args.batch as Delivery[]);
    ctx.db.station.key.update({ ...row, cursor: next.cursor, eventsJson: JSON.stringify(next.events), serverAt: time });
    // A previous read response must not retain the last visitor's history after
    // reset. A racing read can safely retry if its acknowledgement is removed.
    if ((args.batch as Delivery[]).some(delivery => delivery.event.type === 'reset-started')) {
      ctx.db.acknowledgements.slot.delete(1);
    }
    return { slot: 0, result: { cursor: next.cursor } };
  }
  if (op === 'heartbeat') {
    ctx.db.station.key.update({ ...row, serverAt: time });
    return { slot: 0, result: { cursor: row.cursor } };
  }
  if (op === 'issuePairing') {
    const pairingHash = hash(args.pairingToken), expiresAt = time + getConfig(ctx).pairingTtlMs;
    ctx.db.station.key.update({ ...row, pairingHash, pairingExpiresAt: expiresAt, consumedPairingHash: undefined });
    return { slot: 0, result: { expiresAt } };
  }
  clearReader(ctx, row);
  return { slot: 0, result: null };
}

export const command = spacetime.reducer({ requestId: t.string(), op: t.string(), argsJson: t.string() }, (ctx, args) => {
  try {
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(args.requestId) || args.argsJson.length > 131072) throw new SessionError('INVALID_ARGUMENT');
    const parsed: unknown = JSON.parse(args.argsJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SessionError('INVALID_ARGUMENT');
    // Each operation is itself replay-safe: stream CAS, delivery cursors, or a
    // capability-bound pairing retry. Never replay an old authorization result.
    const { slot, result } = execute(ctx, args.op, parsed as Record<string, unknown>);
    ack(ctx, slot, args.requestId, result);
  } catch (error) {
    // Rejected reducers roll back all writes. They do not allocate ack rows for
    // unauthenticated identities or expose argument text through error messages.
    throw new SenderError(error instanceof SessionError ? error.code : 'SERVICE_ERROR');
  }
});

const Ack = t.object('CommandAck', { requestId: t.string(), resultJson: t.string(), errorCode: t.string() });
export const ownerAck = spacetime.view({ name: 'owner_ack', public: true }, t.option(Ack), ctx => {
  const producer = ctx.db.acknowledgements.slot.find(0), reader = ctx.db.acknowledgements.slot.find(1);
  const own = [producer, reader].filter(row => row?.sender.isEqual(ctx.sender));
  const row = own.sort((a, b) => a!.at > b!.at ? -1 : a!.at < b!.at ? 1 : 0)[0];
  return row ? { requestId: row.requestId, resultJson: row.resultJson, errorCode: row.errorCode } : undefined;
});
const Snapshot = t.object('SessionSnapshotPayload', { viewJson: t.string() });
export const sessionSnapshot = spacetime.view({ name: 'session_snapshot', public: true }, t.option(Snapshot), ctx => {
  const row = ctx.db.station.key.find('main');
  if (!row?.readerIdentity?.isEqual(ctx.sender) || !row.readerHash || row.readerExpiresAt! <= row.serverAt) return undefined;
  return { viewJson: JSON.stringify(view(row, row.readerAfter)) };
});
