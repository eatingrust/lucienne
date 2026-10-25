/** Main-process producer transport. Never pass producer capabilities to a renderer. */
import type { MutationPort } from './ports.js';
import { SpacetimeRuntime, SpacetimeTransportError, type SpacetimeOptions } from './spacetime-runtime.js';

export type { SpacetimeOptions } from './spacetime-runtime.js';
export { SpacetimeTransportError } from './spacetime-runtime.js';
export interface SpacetimeMutations extends MutationPort {
  close(): void;
  getAuthToken(): string | undefined;
}
const producerOperations = new Set(['inspectProducer', 'open', 'publish', 'heartbeat', 'issuePairing', 'revokeReader']);
export function createSpacetimeMutations(options: SpacetimeOptions): SpacetimeMutations {
  const runtime = new SpacetimeRuntime(options);
  return {
    call: (name, args) => producerOperations.has(name)
      ? runtime.call(name, args)
      : Promise.reject(new SpacetimeTransportError('INVALID_ARGUMENT')),
    close: () => runtime.close(),
    getAuthToken: () => runtime.getAuthToken(),
  };
}
