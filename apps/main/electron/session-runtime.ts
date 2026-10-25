import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RunEvent } from '../../../contracts/index.js';
import { SessionPublisher, type PublisherStatus } from '../../../services/session/src/publisher.js';
import { createSpacetimeMutations, type SpacetimeMutations, type SpacetimeOptions } from '../../../services/session/src/spacetime-main.js';
import { validateSpacetimeOptions } from '../../../services/session/src/spacetime-runtime.js';
import { projectEvent } from '../../../services/session/src/projection.js';
import type { MutationPort } from '../../../services/session/src/ports.js';

const CONFIG_BYTES = 32_768, AUTH_BYTES = 16_385, MAX_QUEUE = 256;
const ConfigSchema = z.strictObject({
  uri: z.string().min(1).max(2048), databaseName: z.string().min(1).max(128),
  producerToken: z.string().regex(/^[a-f0-9]{64}$/),
});
type Config = z.infer<typeof ConfigSchema>;
type Publisher = Pick<SessionPublisher, 'enqueue' | 'issuePairing' | 'resume' | 'inspect' | 'close'>;
export type SessionRuntimeStatus = PublisherStatus | 'disabled' | 'unavailable';
export interface SessionRuntimeSnapshot { readonly status: SessionRuntimeStatus; readonly queued: number }
/** Private main-process handoff only. Never serialize this capability into renderer state. */
export interface PrivatePairingCapability { uri: string; databaseName: string; pairingToken: string; expiresAt: number }
export interface SessionRuntimeOptions {
  userData: string;
  env?: Readonly<Record<string, string | undefined>>;
  onStatus?: (snapshot: SessionRuntimeSnapshot) => void | Promise<void>;
}
/** Injected by trusted tests only; production always uses one module-owned boot identity. */
export interface SessionRuntimeDependencies {
  boot?: object;
  createTransport?: (options: SpacetimeOptions) => SpacetimeMutations;
  createPublisher?: (port: MutationPort, producerToken: string, onStatus: (status: PublisherStatus) => void) => Publisher;
  uid?: () => number;
  persistAuthToken?: (file: string, token: string) => Promise<void>;
}
export interface MainSessionRuntime {
  /** Await local initialization before enabling selection. This never awaits a network connection. */
  initialize(): Promise<SessionRuntimeSnapshot>;
  enqueue(event: RunEvent): void;
  snapshot(): SessionRuntimeSnapshot;
  resume(): Promise<void>;
  issuePairing(): Promise<PrivatePairingCapability>;
  close(): Promise<void>;
}
const error = (code: string) => Object.assign(new Error(code), { code });
function absolute(value: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\x00-\x1f\x7f]/.test(value))
    throw error('SESSION_CONFIG_INVALID');
  return value;
}
function actualUid(): number {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || process.geteuid?.() !== uid) throw error('SESSION_CONFIG_PERMISSIONS');
  return uid!;
}
async function noSymlinks(file: string): Promise<void> {
  let current = path.parse(file).root;
  for (const part of file.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw error('SESSION_CONFIG_PERMISSIONS'); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  }
}
function privateMetadata(stat: Stats, uid: number, maximum: number): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600 ||
    stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) throw error('SESSION_CONFIG_PERMISSIONS');
}
async function readPrivate(file: string, uid: number, maximum: number): Promise<string | undefined> {
  await noSymlinks(file);
  let before;
  try { before = await lstat(file); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
  privateMetadata(before, uid, maximum);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); privateMetadata(stat, uid, maximum);
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw error('SESSION_CONFIG_PERMISSIONS');
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(); privateMetadata(after, uid, maximum);
    if (bytesRead !== after.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytesRead > maximum)
      throw error('SESSION_CONFIG_INVALID');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
function authToken(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384 || /[\s\x00-\x1f\x7f]/.test(value))
    throw error('SESSION_AUTH_INVALID');
  return value;
}
async function writePrivateAuth(file: string, token: string, uid: number, active: () => boolean): Promise<void> {
  await noSymlinks(file);
  const directory = await lstat(path.dirname(file));
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) !== 0) throw error('SESSION_CONFIG_PERMISSIONS');
  // Never replace an unprotected, linked or foreign credential file.
  const previous = await readPrivate(file, uid, AUTH_BYTES);
  const temporary = path.join(path.dirname(file), `.spacetime-auth-${randomUUID()}.tmp`);
  let handle;
  try {
    if (!active()) throw error('SESSION_RUNTIME_CLOSED');
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${token}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
    if (!active()) throw error('SESSION_RUNTIME_CLOSED');
    await noSymlinks(file);
    const current = await readPrivate(file, uid, AUTH_BYTES);
    if (current !== previous) throw error('SESSION_AUTH_CHANGED');
    if (!active()) throw error('SESSION_RUNTIME_CLOSED');
    await rename(temporary, file);
  } finally {
    try { await handle?.close(); }
    finally { await unlink(temporary).catch(cause => { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }); }
  }
}

class Runtime implements MainSessionRuntime {
  private state: SessionRuntimeStatus = 'starting';
  private closed = false;
  private failed = false;
  private initialized = false;
  private initializePromise?: Promise<SessionRuntimeSnapshot>;
  private closePromise?: Promise<void>;
  private publisher?: Publisher;
  private transport?: SpacetimeMutations;
  private readonly disposed = new WeakSet<object>();
  private notificationQueued = false;
  private queue: RunEvent[] = [];
  private persistence: Promise<void> = Promise.resolve();
  private config?: Config;
  private authFile?: string;
  private readonly configOverride: string | undefined;
  private readonly userData: string;
  private readonly onStatus: SessionRuntimeOptions['onStatus'];
  private readonly dependencies: Readonly<SessionRuntimeDependencies>;
  constructor(options: SessionRuntimeOptions, dependencies: SessionRuntimeDependencies) {
    this.userData = options.userData;
    this.configOverride = (options.env ?? process.env).LUCIENNE_SPACETIME_CONFIG_FILE;
    this.onStatus = options.onStatus;
    this.dependencies = { ...dependencies };
  }
  snapshot(): SessionRuntimeSnapshot {
    let queued = this.queue.length;
    if (this.publisher && !this.closed && !this.failed) {
      try { queued = this.publisher.inspect().queued; } catch { /* Snapshot observation cannot break local lifecycle. */ }
    }
    return Object.freeze({ status: this.state,
      queued: Number.isSafeInteger(queued) && queued >= 0 ? Math.min(MAX_QUEUE, queued) : 0 });
  }
  private notify(): void {
    if (this.notificationQueued) return;
    this.notificationQueued = true;
    // Publisher finishes its own status transition (including timer ownership) before observers can close it.
    queueMicrotask(() => {
      this.notificationQueued = false;
      try { Promise.resolve(this.onStatus?.(this.snapshot())).catch(() => {}); } catch { /* Observer isolation. */ }
    });
  }
  private report(status: PublisherStatus): void {
    if (this.closed || this.failed) return;
    if (status === 'unavailable') { this.unavailable(); return; }
    if (!['starting', 'connected', 'offline', 'overflow', 'closed'].includes(status)) { this.unavailable(); return; }
    this.state = status; this.notify();
  }
  private dispose(resource: { close(): void } | undefined): void {
    if (!resource || this.disposed.has(resource)) return;
    this.disposed.add(resource);
    try { resource.close(); } catch { /* Always close the other independently owned resource too. */ }
  }
  private cleanup(): void {
    const publisher = this.publisher, transport = this.transport;
    this.publisher = undefined; this.transport = undefined;
    this.dispose(publisher); this.dispose(transport);
  }
  private unavailable(): void {
    if (this.closed || this.state === 'overflow') return;
    this.failed = true; this.state = 'unavailable'; this.queue = [];
    this.cleanup(); this.notify();
  }
  private active(): boolean { return !this.closed && !this.failed && this.state !== 'overflow'; }
  private persist(token: string): Promise<void> {
    if (!this.active() || !this.authFile) return Promise.reject(error('SESSION_RUNTIME_CLOSED'));
    try { authToken(token); } catch { this.unavailable(); return Promise.reject(error('SESSION_AUTH_PERSISTENCE_FAILED')); }
    const file = this.authFile;
    const job = this.persistence.then(async () => {
      if (!this.active()) throw error('SESSION_RUNTIME_CLOSED');
      if (this.dependencies.persistAuthToken) await this.dependencies.persistAuthToken(file, token);
      else await writePrivateAuth(file, token, (this.dependencies.uid ?? actualUid)(), () => this.active());
      if (!this.active()) throw error('SESSION_RUNTIME_CLOSED');
    });
    const guarded = job.catch(() => {
      if (!this.closed) this.unavailable();
      throw error(this.closed ? 'SESSION_RUNTIME_CLOSED' : 'SESSION_AUTH_PERSISTENCE_FAILED');
    });
    // Preserve failures as a barrier; a failed identity write never authorizes a later RPC.
    this.persistence = guarded;
    void guarded.catch(() => {});
    return guarded;
  }
  private async withPersistedIdentity<T>(action: () => T | Promise<T>): Promise<T> {
    let pending;
    do { pending = this.persistence; await pending; } while (pending !== this.persistence);
    if (!this.active()) throw error('SESSION_RUNTIME_CLOSED');
    // Invoke in this continuation: another onToken must not slip between the final check and the action.
    return action();
  }
  initialize(): Promise<SessionRuntimeSnapshot> {
    // Assign ownership before invoking callbacks, including failures before the first filesystem await.
    this.initializePromise ??= Promise.resolve().then(() => this.initializeOnce());
    return this.initializePromise.then(() => this.snapshot());
  }
  private async initializeOnce(): Promise<SessionRuntimeSnapshot> {
    try {
      if (!this.active() || this.state === 'overflow') return this.snapshot();
      const userData = absolute(this.userData);
      const file = this.configOverride === undefined ? path.join(userData, 'spacetime-runtime.json') : absolute(this.configOverride);
      const uid = (this.dependencies.uid ?? actualUid)();
      const text = await readPrivate(file, uid, CONFIG_BYTES);
      if (!this.active()) return this.snapshot();
      if (text === undefined) {
        if (this.configOverride !== undefined) throw error('SESSION_CONFIG_UNAVAILABLE');
        this.state = 'disabled'; this.queue = []; this.initialized = true; this.notify(); return this.snapshot();
      }
      const config = ConfigSchema.parse(JSON.parse(text));
      validateSpacetimeOptions(config);
      this.authFile = path.join(userData, 'spacetime-auth-token.key');
      const savedAuth = await readPrivate(this.authFile, uid, AUTH_BYTES);
      if (!this.active()) return this.snapshot();
      const savedToken = savedAuth === undefined ? undefined : authToken(savedAuth.trim());
      this.config = Object.freeze(config);
      const transport = (this.dependencies.createTransport ?? createSpacetimeMutations)({
        uri: config.uri, databaseName: config.databaseName,
        ...(savedToken ? { authToken: savedToken } : {}), onToken: token => this.persist(token),
      });
      if (!this.active()) { this.dispose(transport); return this.snapshot(); }
      this.transport = transport;
      // Fence late continuations inside SessionPublisher after shutdown, and wait for accepted token writes.
      const port: MutationPort = { call: (name, args) => this.withPersistedIdentity(() => {
        if (!this.active() || this.transport !== transport) throw error('SESSION_RUNTIME_CLOSED');
        return transport.call(name, args);
      }) };
      const publisher = (this.dependencies.createPublisher ?? ((port, token, status) => new SessionPublisher(port, token, status)))
        (port, config.producerToken, status => this.report(status));
      if (!this.active()) { this.dispose(publisher); this.cleanup(); return this.snapshot(); }
      this.publisher = publisher; this.initialized = true;
      const buffered = this.queue; this.queue = [];
      for (const event of buffered) {
        if (!this.active()) break;
        publisher.enqueue(event);
      }
      this.notify();
    } catch { this.unavailable(); }
    return this.snapshot();
  }
  enqueue(input: RunEvent): void {
    if (!this.active() || this.state === 'disabled' || this.state === 'overflow') return;
    try {
      const event = projectEvent(input);
      if (this.publisher) this.publisher.enqueue(event);
      else if (!this.initialized) {
        if (this.queue.length === MAX_QUEUE) { this.state = 'overflow'; this.notify(); return; }
        this.queue.push(event);
      }
      this.notify();
    } catch { this.unavailable(); }
  }
  async resume(): Promise<void> {
    await this.initialize();
    if (!this.active() || !this.publisher) throw error('SESSION_RUNTIME_UNAVAILABLE');
    try { await this.withPersistedIdentity(() => this.publisher!.resume()); }
    catch { if (this.active()) this.report('offline'); throw error('SESSION_RUNTIME_UNAVAILABLE'); }
    if (!this.active()) throw error('SESSION_RUNTIME_CLOSED');
    this.notify();
  }
  async issuePairing(): Promise<PrivatePairingCapability> {
    await this.initialize();
    const publisher = this.publisher, config = this.config;
    if (!this.active() || !publisher || !config) throw error('SESSION_RUNTIME_UNAVAILABLE');
    try {
      const pairing = await this.withPersistedIdentity(() => publisher.issuePairing());
      return await this.withPersistedIdentity(() => {
        if (!this.active() || this.publisher !== publisher || !/^[a-f0-9]{64}$/.test(pairing.pairingToken) ||
          !Number.isSafeInteger(pairing.expiresAt) || pairing.expiresAt <= Date.now()) throw error('SESSION_PAIRING_UNAVAILABLE');
        return { uri: config.uri, databaseName: config.databaseName, pairingToken: pairing.pairingToken, expiresAt: pairing.expiresAt };
      });
    } catch {
      if (this.active()) this.report('offline');
      throw error(this.closed ? 'SESSION_RUNTIME_CLOSED' : 'SESSION_PAIRING_UNAVAILABLE');
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true; this.state = 'closed'; this.queue = [];
    // Close network resources immediately. Only accepted local file writes participate in this barrier.
    this.closePromise = this.persistence.catch(() => {});
    this.cleanup(); this.config = undefined; this.notify();
    return this.closePromise;
  }
}

const productionBoot = {};
const bootRuntimes = new WeakMap<object, MainSessionRuntime>();
/** Main owns this singleton before creating/selecting sessions. Closing is permanent for this boot. */
export function createSessionRuntime(options: SessionRuntimeOptions,
  dependencies: SessionRuntimeDependencies = {}): MainSessionRuntime {
  const boot = dependencies.boot ?? productionBoot;
  let runtime = bootRuntimes.get(boot);
  if (!runtime) { runtime = new Runtime(options, dependencies); bootRuntimes.set(boot, runtime); }
  return runtime;
}
