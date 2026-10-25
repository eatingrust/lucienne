import { ConvexHttpClient, ConvexClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { MutationPort, PairingPort, SubscriptionPort } from './ports.js';

function httpClient(url: string): ConvexHttpClient {
  checkUrl(url);
  const client = new ConvexHttpClient(url, {
    logger: false,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }),
  });
  return client;
}
export function createConvexMutations(url: string): MutationPort {
  const client = httpClient(url);
  return { call: (name, args) => name === 'inspectProducer'
    ? client.query(makeFunctionReference<'query'>('sessions:inspectProducer'), args)
    : client.mutation(makeFunctionReference<'mutation'>(`sessions:${name}`), args) };
}
function checkUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/^[a-z0-9-]+\.convex\.cloud$/.test(u.hostname) || u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('INVALID_CONVEX_URL');
}
/** Fixed pair endpoint; the supplied method name cannot select producer operations. */
export function createConvexPairing(url: string): PairingPort {
  const client = httpClient(url);
  return { call: (_name, args) => client.mutation(makeFunctionReference<'mutation'>('sessions:pair'), args) };
}
export function createConvexSubscription(url: string): SubscriptionPort {
  checkUrl(url);
  return { subscribe: (args, update, error) => {
    const client = new ConvexClient(url, { logger: false, reportDebugInfoToConvex: false });
    const unsubscribe = client.onUpdate(makeFunctionReference<'query'>('sessions:read'), args, update, error);
    return () => { unsubscribe(); void client.close().catch(() => {}); };
  } };
}
