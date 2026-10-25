import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// Private storage envelope only. RunEvent is validated by host's schema on ingress.
export default defineSchema({
  station: defineTable({
    key: v.literal('main'), streamId: v.string(), cursor: v.number(),
    events: v.array(v.object({ cursor: v.number(), event: v.any() })),
    serverAt: v.number(), pairingHash: v.optional(v.string()), pairingExpiresAt: v.optional(v.number()),
    consumedPairingHash: v.optional(v.string()), readerHash: v.optional(v.string()), readerExpiresAt: v.optional(v.number()),
  }).index('by_key', ['key']),
});
