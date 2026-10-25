import { mutationGeneric as mutation, queryGeneric as query } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { appendBatch } from '../src/projection.js';
import { authorizeToken, tokenHash, assertStreamId, PAIRING_TTL_MS, READER_TTL_MS, SessionError } from '../src/capabilities.js';

const producer = { producerToken: v.string(), streamId: v.string() };
async function station(ctx: any) { return ctx.db.query('station').withIndex('by_key', (q: any) => q.eq('key', 'main')).unique(); }
async function authorize(ctx: any, args: { producerToken: string; streamId: string }) {
  await authorizeToken(args.producerToken, process.env.LUCIENNE_SESSION_PRODUCER_SHA256);
  assertStreamId(args.streamId);
  const row = await station(ctx);
  if (!row || row.streamId !== args.streamId) throw new SessionError('STALE_STREAM');
  return row;
}
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw new ConvexError({ code: error instanceof SessionError ? error.code : 'SERVICE_ERROR' }); }
}
export const inspectProducer = query({
  args: { producerToken: v.string() },
  handler: (ctx, args) => safe(async () => {
    await authorizeToken(args.producerToken, process.env.LUCIENNE_SESSION_PRODUCER_SHA256);
    return { streamId: (await station(ctx))?.streamId ?? null };
  }),
});
export const open = mutation({
  args: { ...producer, expectedStreamId: v.union(v.string(), v.null()) },
  handler: (ctx, args) => safe(async () => {
    await authorizeToken(args.producerToken, process.env.LUCIENNE_SESSION_PRODUCER_SHA256);
    assertStreamId(args.streamId);
    const row = await station(ctx);
    if (row?.streamId === args.streamId) return { streamId: row.streamId, cursor: row.cursor };
    if ((row?.streamId ?? null) !== args.expectedStreamId) throw new SessionError('STALE_STREAM');
    const data = { key: 'main' as const, streamId: args.streamId, cursor: 0, events: [], serverAt: Date.now() };
    if (row) await ctx.db.replace(row._id, data); else await ctx.db.insert('station', data);
    return { streamId: args.streamId, cursor: 0 };
  }),
});
export const publish = mutation({
  args: { ...producer, batch: v.array(v.object({ cursor: v.number(), event: v.any() })) },
  handler: (ctx, args) => safe(async () => {
    const row = await authorize(ctx, args);
    const next = appendBatch(row, args.batch);
    await ctx.db.patch(row._id, { ...next, serverAt: Date.now() });
    return { cursor: next.cursor };
  }),
});
export const heartbeat = mutation({
  args: producer,
  handler: (ctx, args) => safe(async () => {
    const row = await authorize(ctx, args);
    await ctx.db.patch(row._id, { serverAt: Date.now() });
    return { cursor: row.cursor };
  }),
});
export const issuePairing = mutation({
  args: { ...producer, pairingToken: v.string() },
  handler: (ctx, args) => safe(async () => {
    const row = await authorize(ctx, args);
    const pairingHash = await tokenHash(args.pairingToken);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    await ctx.db.patch(row._id, { pairingHash, pairingExpiresAt: expiresAt, consumedPairingHash: undefined });
    return { expiresAt };
  }),
});
export const pair = mutation({
  args: { pairingToken: v.string(), readerToken: v.string() },
  handler: (ctx, args) => safe(async () => {
    const row = await station(ctx);
    const pairingHash = await tokenHash(args.pairingToken), readerHash = await tokenHash(args.readerToken);
    // Retry of an uncertain successful response is safe only for the SAME reader.
    if (row?.consumedPairingHash === pairingHash && row.readerHash === readerHash && row.readerExpiresAt > Date.now()) {
      return { streamId: row.streamId, expiresAt: row.readerExpiresAt };
    }
    if (!row?.pairingHash || row.pairingHash !== pairingHash) throw new SessionError('UNAUTHORIZED');
    if (row.pairingExpiresAt <= Date.now()) throw new SessionError('PAIRING_EXPIRED');
    const expiresAt = Date.now() + READER_TTL_MS;
    await ctx.db.patch(row._id, { readerHash, readerExpiresAt: expiresAt, consumedPairingHash: pairingHash, pairingHash: undefined, pairingExpiresAt: undefined });
    return { streamId: row.streamId, expiresAt };
  }),
});
export const revokeReader = mutation({
  args: producer,
  handler: (ctx, args) => safe(async () => {
    const row = await authorize(ctx, args);
    await ctx.db.patch(row._id, { readerHash: undefined, readerExpiresAt: undefined, consumedPairingHash: undefined, pairingHash: undefined, pairingExpiresAt: undefined });
    return null;
  }),
});
export const read = query({
  args: { readerToken: v.string(), after: v.number() },
  handler: (ctx, args) => safe(async () => {
    if (!Number.isSafeInteger(args.after) || args.after < 0) throw new SessionError('INVALID_ARGUMENT');
    const row = await station(ctx);
    await authorizeToken(args.readerToken, row?.readerHash);
    if (row.readerExpiresAt <= Date.now()) throw new SessionError('UNAUTHORIZED');
    const oldestCursor = row.events[0]?.cursor ?? row.cursor + 1;
    return { streamId: row.streamId, cursor: row.cursor, events: row.events,
      serverAt: row.serverAt, readerExpiresAt: row.readerExpiresAt, oldestCursor,
      gap: args.after < oldestCursor - 1 };
  }),
});
