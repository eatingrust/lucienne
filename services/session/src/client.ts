// Compatibility entrypoint. New consumers use main.ts or companion.ts explicitly.
export * from './publisher.js';
export * from './watch.js';
export { createConvexMutations, createConvexSubscription } from './convex.js';
export type { MutationPort, SubscriptionPort } from './ports.js';
