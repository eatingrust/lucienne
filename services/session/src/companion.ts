/** Provider-neutral passive display API. No producer, native or database capability. */
export { pairCompanion, watchCompanion } from './watch.js';
export type { CompanionState } from './watch.js';
export type { PairingPort, SubscriptionPort } from './ports.js';
export type { SessionView } from './projection.js';
export { randomToken } from './capabilities.js';
