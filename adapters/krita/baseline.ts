import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Only Krita-owned configuration names are eligible; unrelated account files are not. */
const PREFERENCES = 'Library/Preferences';
const SAVED_STATE = 'Library/Saved Application State';
const FIXED_PATHS = [
  'kritarc', 'kritadisplayrc', 'kritashortcutsrc', 'kritaopenglrc',
  'org.krita.plist', 'org.kde.krita.plist',
].map(name => `${PREFERENCES}/${name}`).concat([
  `${SAVED_STATE}/org.krita.savedState`, `${SAVED_STATE}/org.kde.krita.savedState`,
]);
const preferenceName = (name: string) => name.length <= 96 && (
  /^krita[a-z0-9]*rc(?:\.(?:lock|bak))?$/.test(name) ||
  /^org\.(?:kde\.)?krita(?:\.[A-Za-z0-9_-]+)*\.plist$/.test(name)
);
// Krita's unnamed-document autosaves. Never match arbitrary .krita* user files.
const autosaveName = (name: string) => /^\.krita-\d+-document_\d+-autosave\.kra(?:~)?$/.test(name);
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const code = (name: string): Error => new Error(`KRITA_BASELINE_${name}`);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

type Tree = { kind: 'absent' } | { kind: 'file'; mode: number; bytes: number; sha256: string }
  | { kind: 'directory'; mode: number; children: Record<string, Tree> };
interface Entry { relativePath: string; tree: Tree }
interface Manifest { version: 1; home: string; entries: Entry[] }
export interface KritaBaselineSnapshot { version: 1; entries: Entry[]; manifestDigest: string }
export interface KritaBaselineInspection { matches: boolean; entries: Entry[]; manifestDigest: string }
interface Budget { entries: number; bytes: number }
export interface BaselineResult {
  preferencesRestored: boolean;
  /** No extra tracked prefs, saved state or unnamed-document autosaves remain. */
  visitorArtifactsCleared: boolean;
  manifestDigest: string;
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || value.includes('\0')) throw code('ABSOLUTE_PATH_REQUIRED');
  return path.resolve(value);
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}
async function statOptional(filename: string) {
  try { return await fs.lstat(filename); } catch (error) { if (missing(error)) return undefined; throw error; }
}
/** Deliberately reject symlinked ancestors instead of resolving outside the allowed roots. */
async function noSymlinkAncestors(filename: string): Promise<void> {
  const parsed = path.parse(filename);
  let current = parsed.root;
  for (const component of filename.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await statOptional(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw code('SYMLINK_REJECTED');
    if (current !== filename && !stat.isDirectory()) throw code('INVALID_ANCESTOR');
  }
}
async function names(directory: string): Promise<string[]> {
  await noSymlinkAncestors(directory);
  try { return (await fs.readdir(directory)).sort(); }
  catch (error) { if (missing(error)) return []; throw error; }
}
async function selectedPaths(home: string): Promise<string[]> {
  const selected = new Set(FIXED_PATHS);
  for (const name of await names(path.join(home, PREFERENCES))) {
    if (preferenceName(name)) selected.add(`${PREFERENCES}/${name}`);
  }
  for (const name of await names(home)) if (autosaveName(name)) selected.add(name);
  return [...selected].sort();
}
async function treeAt(filename: string, budget: Budget, copyTo?: string): Promise<Tree> {
  if (++budget.entries > 8192) throw code('TOO_MANY_FILES');
  await noSymlinkAncestors(filename);
  const stat = await statOptional(filename);
  if (!stat) return { kind: 'absent' };
  if (stat.isSymbolicLink()) throw code('SYMLINK_REJECTED');
  const mode = stat.mode & 0o7777;
  if (stat.isDirectory()) {
    if (copyTo) await fs.mkdir(copyTo, { mode: 0o700 });
    const children: Record<string, Tree> = Object.create(null) as Record<string, Tree>;
    for (const name of (await fs.readdir(filename)).sort()) {
      if (name === '.' || name === '..' || name.includes(path.sep)) throw code('INVALID_ENTRY');
      children[name] = await treeAt(path.join(filename, name), budget, copyTo ? path.join(copyTo, name) : undefined);
      if (children[name].kind === 'absent') throw code('SOURCE_CHANGED');
    }
    if (copyTo) await fs.chmod(copyTo, mode);
    return { kind: 'directory', mode, children };
  }
  if (!stat.isFile()) throw code('UNSUPPORTED_FILE_TYPE');
  if (stat.size > 64 * 1024 * 1024 || (budget.bytes += stat.size) > 256 * 1024 * 1024) throw code('TOO_MANY_BYTES');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw code('SOURCE_CHANGED');
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode) throw code('SOURCE_CHANGED');
  } finally { await handle.close(); }
  if (copyTo) {
    const output = await fs.open(copyTo, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(bytes); await output.sync(); } finally { await output.close(); }
    await fs.chmod(copyTo, mode);
  }
  return { kind: 'file', mode, bytes: bytes.length, sha256: hash(bytes) };
}
function equalTree(a: Tree, b: Tree): boolean { return JSON.stringify(a) === JSON.stringify(b); }
async function ensureParents(filename: string): Promise<void> {
  const parent = path.dirname(filename);
  await noSymlinkAncestors(parent);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await noSymlinkAncestors(parent);
}

/**
 * Capture/restore only after the runtime has verified the dedicated account and
 * exclusive native-process ownership. This helper never launches or quits Krita.
 * A successful capture is durable before callers may enable the bridge or write prefs.
 */
export class KritaBaseline {
  readonly manifestPath: string;
  readonly manifestDigest: string;
  private constructor(readonly home: string, readonly backupDirectory: string, private readonly manifest: Manifest) {
    this.manifestPath = path.join(backupDirectory, 'manifest.json');
    this.manifestDigest = hash(JSON.stringify(manifest));
  }

  static async capture(options: { home: string; backupDirectory: string }): Promise<KritaBaseline> {
    const home = absolute(options.home), backup = absolute(options.backupDirectory);
    await noSymlinkAncestors(home);
    const homeStat = await fs.lstat(home);
    if (!homeStat.isDirectory()) throw code('INVALID_HOME');
    const sources = await selectedPaths(home);
    const relativeBackup = path.relative(home, backup);
    const firstHomeComponent = relativeBackup.split(path.sep)[0];
    if (sources.some(source => overlaps(path.join(home, source), backup)) ||
        overlaps(path.join(home, PREFERENCES), backup) || overlaps(path.join(home, SAVED_STATE), backup) ||
        autosaveName(firstHomeComponent) || backup === home) throw code('OVERLAPPING_PATHS');
    await noSymlinkAncestors(backup);
    if (await statOptional(backup)) throw code('BACKUP_ALREADY_EXISTS');
    await ensureParents(backup);
    const staging = await fs.mkdtemp(path.join(path.dirname(backup), '.krita-baseline-'));
    await fs.chmod(staging, 0o700);
    try {
      const entries: Entry[] = [];
      const budget = { entries: 0, bytes: 0 };
      for (const relativePath of sources) {
        const destination = path.join(staging, 'files', relativePath);
        await ensureParents(destination);
        entries.push({ relativePath, tree: await treeAt(path.join(home, relativePath), budget, destination) });
      }
      const manifest: Manifest = { version: 1, home, entries };
      const manifestPath = path.join(staging, 'manifest.json');
      const output = await fs.open(manifestPath, 'wx', 0o600);
      try { await output.writeFile(JSON.stringify(manifest)); await output.sync(); } finally { await output.close(); }
      // Refuse a second owner rather than replace a previous recovery journal.
      if (await statOptional(backup)) throw code('BACKUP_ALREADY_EXISTS');
      await fs.rename(staging, backup);
      const result = new KritaBaseline(home, backup, manifest);
      await result.validateBackup();
      if (!await result.verify()) throw code('SOURCE_CHANGED');
      return result;
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async validateBackup(): Promise<void> {
    await noSymlinkAncestors(this.manifestPath);
    const manifestBytes = await fs.readFile(this.manifestPath);
    if (hash(manifestBytes) !== this.manifestDigest) throw code('MANIFEST_CHANGED');
    const budget = { entries: 0, bytes: 0 };
    for (const entry of this.manifest.entries) {
      const observed = await treeAt(path.join(this.backupDirectory, 'files', entry.relativePath), budget);
      if (!equalTree(entry.tree, observed)) throw code('BACKUP_CORRUPTED');
    }
  }

  /** Read-only evidence projection. Contains relative paths/metadata/digests, never file contents or the account home. */
  snapshot(): KritaBaselineSnapshot {
    return structuredClone({ version: 1, entries: this.manifest.entries, manifestDigest: this.manifestDigest });
  }

  /** Fresh observed hashes/modes/types, including added or missing tracked entries. Never mutates native files. */
  async inspect(): Promise<KritaBaselineInspection> {
    const budget = { entries: 0, bytes: 0 };
    const expected = new Map(this.manifest.entries.map(entry => [entry.relativePath, entry.tree]));
    const paths = [...new Set([...expected.keys(), ...await selectedPaths(this.home)])].sort();
    const entries: Entry[] = [];
    let matches = true;
    for (const relativePath of paths) {
      const tree = await treeAt(path.join(this.home, relativePath), budget);
      entries.push({ relativePath, tree });
      if (!equalTree(expected.get(relativePath) ?? { kind: 'absent' }, tree)) matches = false;
    }
    return { matches, entries, manifestDigest: this.manifestDigest };
  }

  /** A fresh native-filesystem comparison; does not infer restoration from a copy result. */
  async verify(): Promise<boolean> { return (await this.inspect()).matches; }

  async restore(): Promise<BaselineResult> {
    // Validate EVERY backup and current tree before deleting any native configuration.
    await this.validateBackup();
    const currentPaths = [...new Set([
      ...this.manifest.entries.map(entry => entry.relativePath), ...await selectedPaths(this.home),
    ])].sort();
    const currentBudget = { entries: 0, bytes: 0 };
    for (const relativePath of currentPaths) await treeAt(path.join(this.home, relativePath), currentBudget);
    const stage = await fs.mkdtemp(path.join(path.dirname(this.backupDirectory), '.krita-restore-'));
    const expected = new Map(this.manifest.entries.map(entry => [entry.relativePath, entry.tree]));
    try {
      // Stage complete replacements before touching originals, retaining the recovery backup.
      const budget = { entries: 0, bytes: 0 };
      for (const entry of this.manifest.entries) {
        if (entry.tree.kind === 'absent') continue;
        const destination = path.join(stage, entry.relativePath);
        await ensureParents(destination);
        const copied = await treeAt(path.join(this.backupDirectory, 'files', entry.relativePath), budget, destination);
        if (!equalTree(copied, entry.tree)) throw code('BACKUP_CORRUPTED');
      }
      for (const relativePath of currentPaths) {
        const destination = path.join(this.home, relativePath);
        await noSymlinkAncestors(destination);
        // Recheck a changing source before an operation capable of deleting a directory.
        await treeAt(destination, { entries: 0, bytes: 0 });
        await fs.rm(destination, { recursive: true, force: true });
        if (expected.get(relativePath)?.kind !== 'absent' && expected.has(relativePath)) {
          await ensureParents(destination);
          await fs.rename(path.join(stage, relativePath), destination);
        }
      }
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    const restored = await this.verify();
    return { preferencesRestored: restored, visitorArtifactsCleared: restored, manifestDigest: this.manifestDigest };
  }
}
