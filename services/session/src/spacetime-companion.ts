/** Browser-safe passive transport. Pairing and watching retain one SDK identity. */
import type { PairingPort, SubscriptionPort } from './ports.js';
import { SpacetimeRuntime, SpacetimeTransportError, type SpacetimeOptions } from './spacetime-runtime.js';

export type { SpacetimeOptions } from './spacetime-runtime.js';
export { SpacetimeTransportError } from './spacetime-runtime.js';
export interface SpacetimeCompanion {
  pairing: PairingPort;
  subscription: SubscriptionPort;
  close(): void;
  getAuthToken(): string | undefined;
}
export function createSpacetimeCompanion(options: SpacetimeOptions): SpacetimeCompanion {
  const runtime = new SpacetimeRuntime(options);
  return {
    pairing: { call: async (_name, args) => {
      const result = await runtime.call('pair', args);
      if (!result || typeof result !== 'object' || !('streamId' in result) ||
        typeof result.streamId !== 'string' || !/^[a-f0-9]{64}$/.test(result.streamId) ||
        !('expiresAt' in result) || !Number.isSafeInteger(result.expiresAt) || (result.expiresAt as number) < 0) {
        throw new SpacetimeTransportError('SERVICE_ERROR');
      }
      return { streamId: result.streamId, expiresAt: result.expiresAt as number };
    } },
    subscription: { subscribe: (args, update, error) => runtime.subscribe(args, update, error) },
    close: () => runtime.close(),
    getAuthToken: () => runtime.getAuthToken(),
  };
}
