import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KdenliveRecoveryStore } from './recovery.js';

/** Only app-owned state, never the surrounding Library or another application's files. */
export const KDENLIVE_STATE_PATHS = Object.freeze([
  'Library/Preferences/kdenliverc',
  'Library/Preferences/kdenlive-layoutsrc',
  'Library/Application Support/kxmlgui5/kdenlive/kdenliveui.rc',
  'Library/Application Support/kdenlive',
  'Library/Application Support/stalefiles/kdenlive',
  'Library/Caches/kdenlive',
  'Library/Caches/org.kde.Kdenlive',
  'Library/Saved Application State/org.kde.Kdenlive.savedState',
  'Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/org.kde.kdenlive.sfl2',
  'Library/Application Support/com.apple.sharedfilelist/com.apple.LSSharedFileList.ApplicationRecentDocuments/org.kde.kdenlive.sfl3',
] as const);

const HISTORY_PATHS = new Set<string>(KDENLIVE_STATE_PATHS.filter(p => p.includes('savedState') || /\.sfl[23]$/.test(p)));
const CONFIG = 'Library/Preferences/kdenliverc';
const MARKER = '.lucienne-kdenlive-session.json';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Entry = { kind: 'file'; bytes: Buffer } | { kind: 'directory' };
type Tree = Map<string, Entry>;

/** Preserve all other native configuration bytes; drop whole recent-history groups. */
export function stripRecentHistory(bytes: Buffer): Buffer {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) throw new Error('KDENLIVE_CONFIG_NOT_UTF8');
  let history = false;
  return Buffer.from(text.split(/(?<=\n)/).filter(line => {
    const group = line.match(/^\[([^\]]+)\]/);
    if (group) history = /^Recent (Files|Dirs)$/i.test(group[1]);
    return !history;
  }).join(''));
}

/** Existing symlinks anywhere in a path are forbidden, including its ancestors. */
export function assertKdenliveSafePath(input: string): string {
  if (!path.isAbsolute(input)) throw new Error('KDENLIVE_PATH_NOT_ABSOLUTE');
  const absolute = path.resolve(input), parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error('KDENLIVE_SYMLINK_PATH');
      if (current !== absolute && !info.isDirectory()) throw new Error('KDENLIVE_PARENT_NOT_DIRECTORY');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return absolute;
}

function readTree(root: string, budget: { count: number; bytes: number }): Tree {
  assertKdenliveSafePath(root);
  const tree: Tree = new Map();
  const visit = (file: string, relative: string): void => {
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === '') return;
      throw error;
    }
    if (++budget.count > 20_000 || (budget.bytes += stat.isFile() ? stat.size : 0) > 128 * 1024 * 1024)
      throw new Error('KDENLIVE_BASELINE_TOO_LARGE');
    if (stat.isSymbolicLink()) throw new Error('KDENLIVE_SYMLINK_PATH');
    if (stat.isDirectory()) {
      tree.set(relative, { kind: 'directory' });
      for (const child of readdirSync(file).sort()) visit(path.join(file, child), relative ? `${relative}/${child}` : child);
    } else if (stat.isFile()) tree.set(relative, { kind: 'file', bytes: readFileSync(file) });
    else throw new Error('KDENLIVE_SPECIAL_FILE');
  };
  visit(root, '');
  return tree;
}

function treeDigest(tree: Tree): string {
  return hash(JSON.stringify([...tree].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) =>
    [name, entry.kind, entry.kind === 'file' ? hash(entry.bytes) : null])));
}

function assertDisposableTree(root: string): void {
  assertKdenliveSafePath(root);
  let count = 0;
  const visit = (file: string, depth: number): void => {
    let info;
    try {info = lstatSync(file);} catch(error) {if (file === root && (error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
    if (++count > 20_000 || depth > 64) throw new Error('KDENLIVE_TREE_LIMIT');
    if (info.isSymbolicLink()) throw new Error('KDENLIVE_SYMLINK_PATH');
    if (info.isDirectory()) for (const name of readdirSync(file)) visit(path.join(file, name), depth + 1);
    else if (!info.isFile()) throw new Error('KDENLIVE_SPECIAL_FILE');
  };
  visit(root, 0);
}

export interface KdenliveBaselineOptions {
  homeDirectory: string;
  sessionDirectory: string;
  runId: string;
  /** Must synchronously check the dedicated account and that Kdenlive is CLOSED. */
  assertClosed: () => void;
  /** Optional repaired native baseline. Both files must match the recorded hashes. */
  nativeSeedDirectory?: string;
  /** Private durable journal outside all target-state and visitor-session roots. */
  recoveryDirectory?: string;
}
export interface KdenliveBaselineInspection {
  preferencesRestored: boolean;
  visitorArtifactsCleared: boolean;
  digest: string;
  mismatchedPaths: string[];
}

/** Capture before first apply. The caller owns app launch/close and mutation serialization.
 * No method launches the app, fabricates target readiness, or mutates outside this whitelist.
 * Durable recovery, when configured, reloads the pre-write snapshot; it never
 * captures visitor-modified state as a replacement baseline.
 */
export class KdenliveBaseline {
  private readonly home: string;
  private readonly session: string;
  private trees?: Map<string, Tree>;
  private claimed = false;
  private claimIdentity?: { dev: number; ino: number };
  private readonly recovery?: KdenliveRecoveryStore;
  private readonly stagingSession?: string;
  private recoveryFinished = false;
  constructor(private readonly options: KdenliveBaselineOptions) {
    this.options = {...options};
    if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(options.runId)) throw new Error('KDENLIVE_BAD_RUN_ID');
    this.home = assertKdenliveSafePath(options.homeDirectory);
    this.session = assertKdenliveSafePath(options.sessionDirectory);
    if (this.home === path.parse(this.home).root || this.session.split(path.sep).filter(Boolean).length < 3 ||
        this.home === this.session || this.home.startsWith(`${this.session}${path.sep}`) ||
        KDENLIVE_STATE_PATHS.some(p => {
          const state = path.join(this.home, p);
          return this.session === state || this.session.startsWith(`${state}${path.sep}`) || state.startsWith(`${this.session}${path.sep}`);
        })) throw new Error('KDENLIVE_UNSAFE_SESSION_DIRECTORY');
    if (options.recoveryDirectory) {
      const directory = assertKdenliveSafePath(options.recoveryDirectory);
      const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
      if (directory.split(path.sep).filter(Boolean).length < 3 || directory === this.home || this.home.startsWith(`${directory}${path.sep}`) ||
        overlaps(directory, this.session) || KDENLIVE_STATE_PATHS.some(p => overlaps(directory,path.join(this.home,p))))
        throw new Error('KDENLIVE_UNSAFE_RECOVERY_DIRECTORY');
      this.recovery = new KdenliveRecoveryStore({directory,home:this.home,session:this.session,runId:options.runId,statePaths:KDENLIVE_STATE_PATHS,assertClosed:options.assertClosed});
      this.stagingSession = path.join(directory,'session-claim');
    }
  }
  static fromRecovery(options: KdenliveBaselineOptions): KdenliveBaseline {
    const baseline = new KdenliveBaseline(options);
    if (!baseline.recovery) throw new Error('KDENLIVE_RECOVERY_DIRECTORY_REQUIRED');
    options.assertClosed();
    const loaded = baseline.recovery.load();
    baseline.trees = loaded.trees;
    baseline.claimIdentity = loaded.claim;
    baseline.claimed = !!loaded.claim;
    baseline.checkSession(); options.assertClosed();
    return baseline;
  }
  capture(): { digest: string; files: number } {
    if (this.trees) throw new Error('KDENLIVE_BASELINE_ALREADY_CAPTURED');
    this.options.assertClosed();
    if (this.options.recoveryDirectory) {
      try {lstatSync(this.options.recoveryDirectory);throw new Error('KDENLIVE_RECOVERY_REQUIRED');}
      catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    const trees = new Map<string, Tree>(), budget = { count: 0, bytes: 0 };
    for (const relative of KDENLIVE_STATE_PATHS) {
      const observed = readTree(path.join(this.home, relative), budget);
      const tree = HISTORY_PATHS.has(relative) ? new Map<string, Entry>() : observed;
      if (relative === CONFIG) {
        const entry = tree.get('');
        if (entry && entry.kind !== 'file') throw new Error('KDENLIVE_INVALID_CONFIG_TYPE');
        if (entry?.kind === 'file') tree.set('', { kind: 'file', bytes: stripRecentHistory(entry.bytes) });
      }
      trees.set(relative, tree);
    }
    if (this.options.nativeSeedDirectory) {
      for (const [name, expected] of [
        ['kdenliverc', '613bd5b2bbed00f10b3476b240c501ee5b0f97d63767c8552a44ecb36d107133'],
        ['kdenlive-layoutsrc', '35a0fafa00e8d11aa4256abd37b389546d1b481681e82a2b452379f1a4a8f6d3'],
      ]) {
        const bytes = readFileSync(assertKdenliveSafePath(path.join(this.options.nativeSeedDirectory, name)));
        if (hash(bytes) !== expected) throw new Error('KDENLIVE_NATIVE_SEED_DIGEST');
        trees.set(`Library/Preferences/${name}`, new Map([['', { kind: 'file', bytes }]]));
      }
    }
    this.options.assertClosed();
    if (this.recovery) {
      this.makeDirectories(path.dirname(this.options.recoveryDirectory!));
      this.recovery.create(trees);
    }
    this.trees = trees;
    return { digest: this.digest(), files: [...trees.values()].reduce((n, tree) => n + [...tree.values()].filter(e => e.kind === 'file').length, 0) };
  }
  private digest(): string {
    if (!this.trees) throw new Error('KDENLIVE_BASELINE_NOT_CAPTURED');
    return hash(JSON.stringify([...this.trees].map(([relative, tree]) => [relative, treeDigest(tree)])));
  }
  /** Claims a previously absent run directory. Existing directories are never adopted. */
  claimSession(): void {
    if (!this.trees) throw new Error('KDENLIVE_BASELINE_NOT_CAPTURED');
    if (this.claimed) throw new Error('KDENLIVE_SESSION_ALREADY_CLAIMED');
    assertKdenliveSafePath(this.session);
    try { lstatSync(this.session); throw new Error('KDENLIVE_SESSION_ALREADY_EXISTS'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.makeDirectories(path.dirname(this.session));
    const directory = this.stagingSession ?? this.session;
    assertKdenliveSafePath(directory);
    this.options.assertClosed(); mkdirSync(directory, { mode: 0o700 });
    const identity = lstatSync(directory);
    this.claimIdentity = { dev: identity.dev, ino: identity.ino };
    this.claimed = true;
    this.options.assertClosed();
    const marker = path.join(directory, MARKER);
    writeFileSync(marker, this.markerBytes(), { mode: 0o600, flag: 'wx' });
    if (this.recovery) {
      this.sync(marker); this.sync(directory);
      // Commit inode+nonce before publishing. A rename failure has not modified
      // native preferences; cold recovery can identify the staged directory.
      this.recovery.setClaim(this.claimIdentity);
      this.options.assertClosed(); assertKdenliveSafePath(this.session);
      try {lstatSync(this.session);throw new Error('KDENLIVE_SESSION_ALREADY_EXISTS');}
      catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      this.options.assertClosed(); renameSync(directory, this.session);
      this.sync(path.dirname(this.session)); this.sync(this.options.recoveryDirectory!);
    }
  }
  private sync(file: string): void {
    this.options.assertClosed(); assertKdenliveSafePath(file);
    const descriptor = openSync(file,'r');
    try {fsyncSync(descriptor);} finally {closeSync(descriptor);}
  }
  private markerBytes(): string {
    return JSON.stringify({version:1,target:'kdenlive',runId:this.options.runId,...(this.recovery ? {nonce:this.recovery.nonce} : {})});
  }
  private makeDirectories(directory: string): void {
    assertKdenliveSafePath(directory);
    try {
      if (!lstatSync(directory).isDirectory()) throw new Error('KDENLIVE_PARENT_NOT_DIRECTORY');
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.makeDirectories(path.dirname(directory));
    this.options.assertClosed(); mkdirSync(directory, { mode: 0o700 });
    if (this.recovery) this.sync(path.dirname(directory));
  }
  private checkSessionAt(directory: string): boolean {
    assertKdenliveSafePath(directory);
    let identity;
    try { identity = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    if (!this.claimed) throw new Error('KDENLIVE_UNOWNED_SESSION');
    if (identity.dev !== this.claimIdentity?.dev || identity.ino !== this.claimIdentity.ino) throw new Error('KDENLIVE_SESSION_REPLACED');
    if (this.recovery && (identity.uid !== process.getuid?.() || (identity.mode & 0o077) !== 0)) throw new Error('KDENLIVE_SESSION_OWNERSHIP');
    const markerPath = assertKdenliveSafePath(path.join(directory, MARKER));
    let markerBytes;
    try {
      const markerStat = lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.nlink !== 1 || markerStat.size > 4096) throw new Error('KDENLIVE_SESSION_MARKER_INVALID');
      markerBytes = readFileSync(markerPath, 'utf8');
    }
    catch (error) {
      // Interrupted claim can leave only our newly-created empty directory.
      // Recover its marker only with the original inode, no intervening content,
      // and a fresh closed-account guard. Never adopt an arbitrary directory.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || readdirSync(directory).length) throw error;
      markerBytes = this.markerBytes();
      this.options.assertClosed(); writeFileSync(markerPath, markerBytes, { mode: 0o600, flag: 'wx' });
    }
    const marker = JSON.parse(markerBytes);
    if (marker.version !== 1 || marker.target !== 'kdenlive' || marker.runId !== this.options.runId ||
      (this.recovery && marker.nonce !== this.recovery.nonce)) throw new Error('KDENLIVE_SESSION_IDENTITY');
    // Session videos may be large; validate their types without loading their bytes.
    assertDisposableTree(directory);
    return true;
  }
  private checkSession(): string | undefined {
    const final = this.checkSessionAt(this.session);
    const staged = !!this.stagingSession && this.checkSessionAt(this.stagingSession);
    if (final && staged) throw new Error('KDENLIVE_AMBIGUOUS_SESSION');
    return final ? this.session : staged ? this.stagingSession : undefined;
  }
  restore(options: {keepSession?: boolean} = {}): KdenliveBaselineInspection {
    if (!this.trees) throw new Error('KDENLIVE_BASELINE_NOT_CAPTURED');
    this.options.assertClosed();
    if (this.recovery && !this.recoveryFinished) {
      const durable = this.recovery.load();
      if (KDENLIVE_STATE_PATHS.some(p => treeDigest(durable.trees.get(p)!) !== treeDigest(this.trees!.get(p)!)) ||
        durable.claim?.dev !== this.claimIdentity?.dev || durable.claim?.ino !== this.claimIdentity?.ino)
        throw new Error('KDENLIVE_RECOVERY_CHANGED');
    }
    // Validate all current trees before deleting anything, including the run marker.
    // Validate visitor trees by metadata, not by loading potentially huge media
    // caches into memory. Snapshot byte limits apply to baseline capture only.
    for (const relative of KDENLIVE_STATE_PATHS) assertDisposableTree(path.join(this.home, relative));
    const session = this.checkSession();
    if (options.keepSession && session !== this.session) throw new Error('KDENLIVE_SESSION_NOT_PUBLISHED');
    for (const [relative, tree] of this.trees) {
      const root = path.join(this.home, relative);
      assertKdenliveSafePath(root);
      this.options.assertClosed(); rmSync(root, { recursive: true, force: true });
      if (this.recovery) {
        let parent = path.dirname(root);
        while (true) {
          try {lstatSync(parent);break;} catch(error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; parent = path.dirname(parent);}
        }
        this.sync(parent);
      }
      for (const [name, entry] of tree) {
        const file = path.join(root, name);
        if (entry.kind === 'directory') this.makeDirectories(file);
        else {
          this.makeDirectories(path.dirname(file));
          assertKdenliveSafePath(file);
          // The app is closed; a synchronous write avoids orphan temporary files
          // if the account/closed guard rejects the next mutation. Retry replaces
          // this entire whitelisted root after any partial filesystem failure.
          this.options.assertClosed(); writeFileSync(file, entry.bytes, { mode: 0o600, flag: 'wx' });
          if (this.recovery) {this.sync(file);this.sync(path.dirname(file));}
        }
      }
    }
    if (session && !options.keepSession) {
      if (this.checkSession() !== session) throw new Error('KDENLIVE_SESSION_REPLACED');
      this.options.assertClosed(); rmSync(session, { recursive: true, force: false });
      if (this.recovery) this.sync(path.dirname(session));
    }
    const inspection = this.inspect();
    if (!inspection.preferencesRestored || (!options.keepSession && !inspection.visitorArtifactsCleared)) throw new Error('KDENLIVE_RESET_READBACK_MISMATCH');
    return inspection;
  }
  inspect(): KdenliveBaselineInspection {
    if (!this.trees) throw new Error('KDENLIVE_BASELINE_NOT_CAPTURED');
    this.options.assertClosed();
    const mismatchedPaths: string[] = [];
    for (const [relative, expected] of this.trees) {
      if (treeDigest(readTree(path.join(this.home, relative), { count: 0, bytes: 0 })) !== treeDigest(expected)) mismatchedPaths.push(relative);
    }
    let visitorArtifactsCleared = true;
    for (const directory of [this.session,...(this.stagingSession ? [this.stagingSession] : [])]) {
      assertKdenliveSafePath(directory);
      try { lstatSync(directory); visitorArtifactsCleared = false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    this.options.assertClosed();
    return { preferencesRestored: mismatchedPaths.length === 0, visitorArtifactsCleared, digest: this.digest(), mismatchedPaths };
  }
  finishRecovery(): {retainedArchive?: string} {
    const inspection = this.inspect();
    if (!inspection.preferencesRestored || !inspection.visitorArtifactsCleared) throw new Error('KDENLIVE_RECOVERY_NOT_RESTORED');
    const result = this.recovery?.finish() ?? {};
    this.recoveryFinished = true;
    return result;
  }
}
