import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertDedicatedConsole } from './native-desktop.js';
import type { PrivatePairingCapability, SessionRuntimeStatus } from './session-runtime.js';
import { validateSpacetimeOptions } from '../../../services/session/src/spacetime-runtime.js';

const FLAG = '--issue-companion-pairing';
const FILE = 'companion-pairing.json';
const MAX_BYTES = 8192;
const capabilitySchema = z.strictObject({ uri: z.string().min(1).max(2048),
  databaseName: z.string().min(1).max(128), pairingToken: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().safe().positive() });
export type PairingHandoffStatus = 'PAIRING_HANDOFF_WRITTEN' | 'PAIRING_HANDOFF_CLOSED' | 'PAIRING_HANDOFF_CANCELLED'
  | 'PAIRING_ACCOUNT_REQUIRED' | 'PAIRING_SESSION_UNAVAILABLE' | 'PAIRING_FILE_UNSAFE'
  | 'PAIRING_HANDOFF_FAILED' | 'PAIRING_HANDOFF_CLEANUP_FAILED';
class HandoffError extends Error { constructor(readonly code: PairingHandoffStatus) { super(code); } }
const fail = (code: PairingHandoffStatus): never => { throw new HandoffError(code); };
type OwnedFile = { dev: number; ino: number; uid: number };
export interface PairingHandoffOptions {
  /** Trusted app.getPath('userData'); no path or capability is accepted through IPC/argv. */
  userData: string;
  sessionStatus(): SessionRuntimeStatus;
  issuePairing(): Promise<PrivatePairingCapability>;
  isClosing(): boolean;
}
/** Credential-free tests only. Production always uses the dedicated-console authorizer below. */
export interface PairingHandoffDependencies {
  authorize?(): Promise<number>;
  beforeCommit?(): Promise<void>;
  now?(): number;
}
export function pairingRequested(argv: readonly string[]): boolean {
  return argv.filter(value => value === FLAG).length === 1 && !argv.some(value => value.startsWith(`${FLAG}=`));
}
async function dedicatedUid(): Promise<number> {
  await assertDedicatedConsole();
  if (process.getuid?.() !== 502 || process.geteuid?.() !== 502) return fail('PAIRING_ACCOUNT_REQUIRED');
  return 502;
}
function sameFile(stat: Stats, owned: OwnedFile): boolean {
  return stat.dev === owned.dev && stat.ino === owned.ino && stat.uid === owned.uid;
}
function safeFile(stat: Stats, uid: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== 1 || stat.size > MAX_BYTES) fail('PAIRING_FILE_UNSAFE');
}
async function optionalStat(file: string): Promise<Stats | undefined> {
  try { return await lstat(file); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
}

/** One main-process exporter; it never constructs a publisher or exposes a capability in its result. */
export class CompanionPairingHandoff {
  private pending?: Promise<PairingHandoffStatus>;
  private publication?: Promise<void>;
  private closing?: Promise<PairingHandoffStatus>;
  private closed = false;
  private generation = 0;
  private published?: OwnedFile;
  private readonly file: string;
  constructor(private readonly options: PairingHandoffOptions, private readonly dependencies: PairingHandoffDependencies = {}) {
    if (!path.isAbsolute(options.userData) || path.resolve(options.userData) !== options.userData ||
      /[\x00-\x1f\x7f]/.test(options.userData)) fail('PAIRING_FILE_UNSAFE');
    this.file = path.join(options.userData, FILE);
  }
  private active(generation: number): void {
    if (this.closed) fail('PAIRING_HANDOFF_CLOSED');
    if (generation !== this.generation || this.options.isClosing()) fail('PAIRING_HANDOFF_CANCELLED');
  }
  private async authorize(): Promise<number> {
    try {
      const uid = await (this.dependencies.authorize ?? dedicatedUid)();
      if (!Number.isSafeInteger(uid) || uid <= 0) return fail('PAIRING_ACCOUNT_REQUIRED');
      return uid;
    } catch { return fail('PAIRING_ACCOUNT_REQUIRED'); }
  }
  private async directory(uid: number): Promise<Stats> {
    let current = path.parse(this.options.userData).root;
    for (const part of this.options.userData.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink()) fail('PAIRING_FILE_UNSAFE');
    }
    const directory = await lstat(this.options.userData);
    if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) !== 0) fail('PAIRING_FILE_UNSAFE');
    return directory;
  }
  private async removeOwned(file: string, owned: OwnedFile): Promise<void> {
    await this.directory(owned.uid);
    const stat = await optionalStat(file);
    if (!stat) return;
    safeFile(stat, owned.uid);
    if (!sameFile(stat, owned)) fail('PAIRING_FILE_UNSAFE');
    await unlink(file);
  }
  private async clearPrevious(uid: number): Promise<void> {
    await this.directory(uid);
    const previous = await optionalStat(this.file);
    if (previous) { safeFile(previous, uid); await this.removeOwned(this.file, previous); }
    this.published = undefined;
  }
  /** A quit attempt invalidates a pending export without permanently disabling a failed-to-quit app. */
  invalidate(): void { this.generation++; }
  request(): Promise<PairingHandoffStatus> {
    if (this.closed) return Promise.resolve('PAIRING_HANDOFF_CLOSED');
    if (this.pending) return this.pending;
    const generation = this.generation;
    // Install the latch before authorization, callbacks or provider work can reenter.
    this.pending = Promise.resolve().then(async () => {
      this.active(generation);
      const uid = await this.authorize();
      this.active(generation);
      // Remove a previous private handoff before issuing another one. No credential contents are read.
      await this.clearPrevious(uid); this.active(generation);
      if (!['starting', 'connected', 'offline'].includes(this.options.sessionStatus())) return fail('PAIRING_SESSION_UNAVAILABLE');
      let raw: unknown;
      try { raw = await this.options.issuePairing(); }
      catch { this.active(generation); return fail('PAIRING_SESSION_UNAVAILABLE'); }
      this.active(generation);
      if (await this.authorize() !== uid) return fail('PAIRING_ACCOUNT_REQUIRED');
      this.active(generation);
      const parsed = capabilitySchema.safeParse(raw);
      if (!parsed.success || parsed.data.expiresAt <= (this.dependencies.now ?? Date.now)()) return fail('PAIRING_HANDOFF_FAILED');
      const capability = parsed.data;
      try { validateSpacetimeOptions({ uri: capability.uri, databaseName: capability.databaseName }); }
      catch { return fail('PAIRING_HANDOFF_FAILED'); }
      this.active(generation);
      // close() waits only for this local file operation, never an outstanding network request.
      const publication = Promise.resolve().then(() => this.publish(capability, uid, generation));
      this.publication = publication;
      try { await publication; }
      finally { if (this.publication === publication) this.publication = undefined; }
      this.active(generation);
      return 'PAIRING_HANDOFF_WRITTEN' as const;
    }).catch(cause => cause instanceof HandoffError ? cause.code : 'PAIRING_HANDOFF_FAILED' as const)
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async publish(capability: PrivatePairingCapability, uid: number, generation: number): Promise<void> {
    this.active(generation);
    const directory = await this.directory(uid);
    const temporary = path.join(this.options.userData, `.companion-pairing-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let owned: OwnedFile | undefined;
    let committed = false;
    let complete = false;
    try {
      this.active(generation);
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.chmod(0o600);
      const before = await handle.stat(); safeFile(before, uid); owned = before;
      await handle.writeFile(JSON.stringify({ uri: capability.uri, databaseName: capability.databaseName,
        pairingToken: capability.pairingToken, expiresAt: capability.expiresAt }) + '\n', 'utf8');
      await handle.sync();
      const after = await handle.stat(); safeFile(after, uid);
      if (!sameFile(after, owned)) fail('PAIRING_FILE_UNSAFE');
      await handle.close(); handle = undefined;
      await this.dependencies.beforeCommit?.();
      this.active(generation);
      if (await this.authorize() !== uid) fail('PAIRING_ACCOUNT_REQUIRED');
      this.active(generation);
      if (capability.expiresAt <= (this.dependencies.now ?? Date.now)()) fail('PAIRING_HANDOFF_FAILED');
      const currentDirectory = await this.directory(uid);
      if (directory.dev !== currentDirectory.dev || directory.ino !== currentDirectory.ino || await optionalStat(this.file))
        fail('PAIRING_FILE_UNSAFE');
      this.active(generation);
      await rename(temporary, this.file); committed = true; this.published = owned;
      const result = await lstat(this.file); safeFile(result, uid);
      if (!sameFile(result, owned)) fail('PAIRING_FILE_UNSAFE');
      this.active(generation);
      if (capability.expiresAt <= (this.dependencies.now ?? Date.now)()) fail('PAIRING_HANDOFF_FAILED');
      complete = true;
    } finally {
      await handle?.close();
      if (owned && !committed) await this.removeOwned(temporary, owned);
      if (owned && committed && !complete) {
        await this.removeOwned(this.file, owned);
        if (this.published === owned) this.published = undefined;
      }
    }
  }
  close(): Promise<PairingHandoffStatus> {
    if (this.closing) return this.closing;
    this.closed = true; this.generation++;
    this.closing = Promise.resolve().then(async () => {
      await this.publication?.catch(() => {});
      if (this.published) { await this.removeOwned(this.file, this.published); this.published = undefined; }
      return 'PAIRING_HANDOFF_CLOSED' as const;
    }).catch(() => 'PAIRING_HANDOFF_CLEANUP_FAILED' as const);
    return this.closing;
  }
}
