import type { SessionView } from './projection.js';

export interface MutationPort {
  call(name: string, args: Record<string, unknown>): Promise<any>;
}
/** The companion can redeem a reader capability, never publish or control a station. */
export interface PairingPort {
  call(name: 'pair', args: { pairingToken: string; readerToken: string }): Promise<{ streamId: string; expiresAt: number }>;
}
export interface SubscriptionPort {
  subscribe(args: { readerToken: string; after: number }, update: (value: SessionView) => void, error: () => void): () => void;
}
