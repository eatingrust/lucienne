/** Opaque station capabilities. Never send producer credentials to a renderer. */
export const PAIRING_TTL_MS = 5 * 60_000;
export const READER_TTL_MS = 12 * 60 * 60_000;
export const MAX_EVENTS = 128;
export const MAX_BATCH = 32;

export type SessionErrorCode = 'UNAUTHORIZED' | 'STALE_STREAM' | 'INVALID_EVENT' |
  'SEQUENCE_GAP' | 'CONFLICT' | 'INVALID_ARGUMENT' | 'PAIRING_EXPIRED';
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode) { super(code); this.name = 'SessionError'; this.code = code; }
}
export function assertToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new SessionError('UNAUTHORIZED');
}
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
}
export async function tokenHash(token: string): Promise<string> {
  assertToken(token);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
export async function authorizeToken(token: string, expectedHash: string | undefined): Promise<void> {
  assertToken(token);
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new SessionError('UNAUTHORIZED');
  const actual = await tokenHash(token);
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  if (diff) throw new SessionError('UNAUTHORIZED');
}
export function assertStreamId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new SessionError('INVALID_ARGUMENT');
}
