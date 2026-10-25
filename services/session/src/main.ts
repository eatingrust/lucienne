/** Main-process only: producer token must never cross a renderer/companion boundary. */
export { SessionPublisher } from './publisher.js';
export type { PublisherStatus } from './publisher.js';
export type { MutationPort } from './ports.js';
export { createConvexMutations } from './convex.js';
export { randomToken, tokenHash } from './capabilities.js';
