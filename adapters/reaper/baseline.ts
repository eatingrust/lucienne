import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';

/** These are the entire persistent write surface of the adapter. No directory rollback. */
const FILES = ['reaper-kb.ini', 'reaper-mouse.ini'] as const;
const INI_KEYS = ['tcpalign', 'mixwnd_vis'] as const;
const MAX_BYTES = 8 * 1024 * 1024;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): Error => new Error(`REAPER_BASELINE_${code}`);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
type IniKey = typeof INI_KEYS[number];
type IniState = Record<IniKey, string | null>;
interface SavedFile { name: typeof FILES[number]; absent: boolean; mode?: number; bytes?: number; sha256?: string }
interface Manifest { version: 1; resourceDirectory: string; files: SavedFile[]; ini: IniState }
export interface ReaperBaselineSnapshot {
  version: 1; files: SavedFile[]; ini: IniState; manifestDigest: string;
  scope: 'adapter-settings-only';
}
export interface ReaperBaselineInspection {
  matches: boolean; files: SavedFile[]; ini: IniState; manifestDigest: string;
  scope: 'adapter-settings-only';
}

function absolute(value: string): string {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw fail('ABSOLUTE_PATH_REQUIRED');
  return path.resolve(value);
}
async function optionalStat(filename: string) {
  try { return await fs.lstat(filename); } catch (error) { if (missing(error)) return undefined; throw error; }
}
/** Reject symlinked ancestors; callers must pass the actual native resource path. */
export async function assertReaperPath(filename: string): Promise<void> {
  filename = absolute(filename);
  let cursor = path.parse(filename).root;
  for (const part of filename.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await optionalStat(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw fail('SYMLINK_REJECTED');
    if (cursor !== filename && !stat.isDirectory()) throw fail('INVALID_ANCESTOR');
  }
}
async function readSafe(filename: string): Promise<{ bytes: Buffer; mode: number } | null> {
  await assertReaperPath(filename);
  const stat = await optionalStat(filename);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) throw fail('REGULAR_FILE_REQUIRED');
  if (stat.size > MAX_BYTES) throw fail('FILE_TOO_LARGE');
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) throw fail('SOURCE_CHANGED');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytes.length !== stat.size || after.mode !== stat.mode)
      throw fail('SOURCE_CHANGED');
    return { bytes, mode: stat.mode & 0o777 };
  } finally { await handle.close(); }
}
function lines(text: string): string[] { return text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []; }
function iniText(data: Awaited<ReturnType<typeof readSafe>>): string {
  if (!data) return '';
  const text = data.bytes.toString('utf8');
  // Never rewrite unknown fields if decoding would silently alter their bytes.
  if (!Buffer.from(text, 'utf8').equals(data.bytes) || text.includes('\0')) throw fail('INI_ENCODING_UNSUPPORTED');
  return text;
}
function body(line: string): string { return line.replace(/[\r\n]+$/, ''); }
function section(line: string): string | undefined {
  return /^\s*\[([^\]]+)\]\s*$/.exec(body(line))?.[1]?.toLowerCase();
}
function ownKey(line: string, currentSection: string): IniKey | undefined {
  if (currentSection !== 'reaper') return undefined;
  const key = /^\s*([^;#=\s]+)\s*=/.exec(body(line))?.[1]?.toLowerCase();
  return INI_KEYS.find(candidate => candidate === key);
}
/** Preserve the exact setting line, but never save unknown configuration or license data. */
export function readAdapterIni(text: string): IniState {
  const result: IniState = { tcpalign: null, mixwnd_vis: null };
  let currentSection = '';
  for (const line of lines(text)) {
    currentSection = section(line) ?? currentSection;
    const key = ownKey(line, currentSection);
    if (!key) continue;
    if (result[key] !== null) throw fail('DUPLICATE_INI_KEY');
    result[key] = body(line);
  }
  return result;
}
/** Change only the two explicitly owned keys. Unrecognized lines remain byte-for-byte. */
export function restoreAdapterIni(current: string, desired: IniState): string {
  readAdapterIni(current); // Refuse ambiguous tracked settings before any mutation.
  const original = lines(current), output: string[] = [];
  let currentSection = '', insertion = -1;
  for (const line of original) {
    const next = section(line);
    if (next !== undefined) {
      if (currentSection === 'reaper' && insertion < 0) insertion = output.length;
      currentSection = next;
    }
    if (!ownKey(line, currentSection)) output.push(line);
  }
  if (currentSection === 'reaper' && insertion < 0) insertion = output.length;
  const wanted = INI_KEYS.flatMap(key => desired[key] === null ? [] : [desired[key]!]);
  if (!wanted.length) return output.join('');
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  if (insertion < 0) {
    if (output.length && !/[\r\n]$/.test(output[output.length - 1]!)) output.push(newline);
    output.push(`[REAPER]${newline}`); insertion = output.length;
  } else if (insertion > 0 && !/[\r\n]$/.test(output[insertion - 1]!)) {
    // Append the separator as its own chunk so the preceding unknown line is unchanged.
    output.splice(insertion++, 0, newline);
  }
  output.splice(insertion, 0, ...wanted.map(line => `${line}${newline}`));
  return output.join('');
}
function metadata(name: typeof FILES[number], data: Awaited<ReturnType<typeof readSafe>>): SavedFile {
  return data ? { name, absent: false, mode: data.mode, bytes: data.bytes.length, sha256: digest(data.bytes) } : { name, absent: true };
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
async function durableWrite(filename: string, bytes: Buffer | string, mode: number): Promise<void> {
  await assertReaperPath(filename);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await assertReaperPath(filename);
  const temporary = path.join(path.dirname(filename), `.lucienne-reaper-${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await assertReaperPath(filename); await fs.rename(temporary, filename); await fs.chmod(filename, mode); }
  finally { await fs.rm(temporary, { force: true }); }
}

/**
 * Runtime must establish the dedicated account, exclusive process ownership and
 * quiescence before capture/restore. This helper does not launch or kill REAPER.
 *
 * The actual resource folder is used. reaper.ini is never rolled back wholesale;
 * its unknown fields, reaper-reginfo*, license .rk files, macOS plist, application
 * state and startup-created defaults are neither backed up nor modified here.
 * This deliberately avoids rolling back evaluation counters or hiding reminders.
 * The runtime separately removes its owned project/media/bridge/session artifacts.
 * Resource-path authority: https://www.reaper.fm/sdk/reascript/reascripthelp.html#GetResourcePath
 * No undocumented evaluation-field assumptions are needed by this allowlist.
 */
export class ReaperBaseline {
  readonly manifestPath: string;
  readonly manifestDigest: string;
  private constructor(readonly resourceDirectory: string, readonly backupDirectory: string, private readonly manifest: Manifest) {
    this.manifestPath = path.join(backupDirectory, 'manifest.json');
    this.manifestDigest = digest(JSON.stringify(manifest));
  }
  static async capture(options: { resourceDirectory: string; backupDirectory: string }): Promise<ReaperBaseline> {
    const resourceDirectory = absolute(options.resourceDirectory), backupDirectory = absolute(options.backupDirectory);
    if (resourceDirectory === backupDirectory || resourceDirectory.startsWith(`${backupDirectory}/`) || backupDirectory.startsWith(`${resourceDirectory}/`))
      throw fail('OVERLAPPING_PATHS');
    await assertReaperPath(resourceDirectory); await assertReaperPath(backupDirectory);
    const resource = await optionalStat(resourceDirectory);
    if (resource && !resource.isDirectory()) throw fail('RESOURCE_DIRECTORY_REQUIRED');
    if (await optionalStat(backupDirectory)) throw fail('BACKUP_ALREADY_EXISTS');
    const fileData = await Promise.all(FILES.map(name => readSafe(path.join(resourceDirectory, name))));
    const iniData = await readSafe(path.join(resourceDirectory, 'reaper.ini'));
    const manifest: Manifest = { version: 1, resourceDirectory,
      files: FILES.map((name, index) => metadata(name, fileData[index]!)), ini: readAdapterIni(iniText(iniData)) };
    await fs.mkdir(path.dirname(backupDirectory), { recursive: true, mode: 0o700 });
    await assertReaperPath(backupDirectory);
    const stage = await fs.mkdtemp(path.join(path.dirname(backupDirectory), '.reaper-baseline-'));
    try {
      await fs.chmod(stage, 0o700);
      for (const [index, name] of FILES.entries()) {
        const data = fileData[index];
        if (data) await durableWrite(path.join(stage, name), data.bytes, data.mode);
      }
      await durableWrite(path.join(stage, 'manifest.json'), JSON.stringify(manifest), 0o600);
      // mkdir is an exclusive claim; never replace another recovery journal.
      await fs.mkdir(backupDirectory, { mode: 0o700 });
      for (const name of await fs.readdir(stage)) await fs.rename(path.join(stage, name), path.join(backupDirectory, name));
      const result = new ReaperBaseline(resourceDirectory, backupDirectory, manifest);
      await result.validateBackup();
      if (!await result.verify()) throw fail('SOURCE_CHANGED');
      return result;
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  private async validateBackup(): Promise<void> {
    const manifest = await readSafe(this.manifestPath);
    if (!manifest || digest(manifest.bytes) !== this.manifestDigest) throw fail('MANIFEST_CHANGED');
    for (const saved of this.manifest.files) {
      if (!equal(saved, metadata(saved.name, await readSafe(path.join(this.backupDirectory, saved.name))))) throw fail('BACKUP_CORRUPTED');
    }
  }
  snapshot(): ReaperBaselineSnapshot {
    return structuredClone({ version: 1, files: this.manifest.files, ini: this.manifest.ini,
      manifestDigest: this.manifestDigest, scope: 'adapter-settings-only' });
  }
  async inspect(): Promise<ReaperBaselineInspection> {
    const files: SavedFile[] = [];
    for (const name of FILES) files.push(metadata(name, await readSafe(path.join(this.resourceDirectory, name))));
    const ini = readAdapterIni(iniText(await readSafe(path.join(this.resourceDirectory, 'reaper.ini'))));
    return { matches: equal(files, this.manifest.files) && equal(ini, this.manifest.ini), files, ini,
      manifestDigest: this.manifestDigest, scope: 'adapter-settings-only' };
  }
  async verify(): Promise<boolean> { return (await this.inspect()).matches; }
  async restore(): Promise<{ preferencesRestored: boolean; manifestDigest: string; scope: 'adapter-settings-only' }> {
    await this.validateBackup();
    // Validate every destination and prepare all bytes before the first write.
    const currentFiles = await Promise.all(FILES.map(name => readSafe(path.join(this.resourceDirectory, name))));
    const restoredFiles = await Promise.all(FILES.map(name => readSafe(path.join(this.backupDirectory, name))));
    const iniPath = path.join(this.resourceDirectory, 'reaper.ini');
    const ini = await readSafe(iniPath);
    const restoredIni = restoreAdapterIni(iniText(ini), this.manifest.ini);
    for (const [index, name] of FILES.entries()) {
      const filename = path.join(this.resourceDirectory, name), saved = restoredFiles[index];
      await assertReaperPath(filename);
      if (!equal(metadata(name, await readSafe(filename)), metadata(name, currentFiles[index]!))) throw fail('SOURCE_CHANGED');
      if (saved) await durableWrite(filename, saved.bytes, saved.mode);
      else await fs.rm(filename, { force: true });
    }
    const latestIni = await readSafe(iniPath);
    if (!equal(latestIni, ini)) throw fail('SOURCE_CHANGED');
    if (restoredIni !== iniText(ini)) await durableWrite(iniPath, restoredIni, ini?.mode ?? 0o600);
    return { preferencesRestored: await this.verify(), manifestDigest: this.manifestDigest, scope: 'adapter-settings-only' };
  }
}
