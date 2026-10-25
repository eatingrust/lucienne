/** Browser boundary for host's main-owned CompanionPairingHandoff JSON file. */
export const MAX_PAIRING_FILE_BYTES = 8192;
export interface PairingFileTarget { uri: string; databaseName: string }
export type PairingFileProblem = 'invalid-file' | 'expired-file' | 'wrong-station';
export class PairingFileError extends Error {
  readonly code: PairingFileProblem;
  constructor(code: PairingFileProblem) { super(code); this.code = code; }
}
const invalid = (): never => { throw new PairingFileError('invalid-file'); };

/** Returns only the code for the already configured ports; it never reconfigures a transport. */
export function parsePairingFile(text: string, target: PairingFileTarget, now = Date.now()): string {
  if (new TextEncoder().encode(text).byteLength > MAX_PAIRING_FILE_BYTES) invalid();
  let input: unknown;
  try { input = JSON.parse(text); } catch { return invalid(); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'databaseName,expiresAt,pairingToken,uri' ||
      typeof value.uri !== 'string' || value.uri.length < 1 || value.uri.length > 2048 ||
      typeof value.databaseName !== 'string' || value.databaseName.length < 1 || value.databaseName.length > 128 ||
      typeof value.pairingToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.pairingToken) ||
      typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return invalid();
  // The main-owned file must name this exact configured station. Do not accept
  // alternate URLs or use the file to select a transport, even if they resolve alike.
  if (value.uri !== target.uri || value.databaseName !== target.databaseName) throw new PairingFileError('wrong-station');
  if (!Number.isFinite(now) || value.expiresAt <= now) throw new PairingFileError('expired-file');
  return value.pairingToken;
}
