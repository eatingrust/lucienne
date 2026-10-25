import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { DesktopPort } from '../../../contracts/ports.js';

const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative(), height: z.number().nonnegative() });
const window = z.object({ windowID: z.number().int(), ownerPID: z.number().int(), ownerBundleID: z.string().optional(),
  ownerSystemRole: z.enum(['window-server', 'dock']).optional(),
  layer: z.number().int(), alpha: z.number().min(0).max(1), onScreen: z.boolean(), boundsCG: rect, requiredMetadataComplete: z.literal(true) });
const inventory = z.object({ available: z.literal(true), totalCount: z.number().int().min(0).max(128), truncated: z.literal(false), windows: z.array(window).max(128) });
export const DesktopProbeSchema = z.object({ protocolVersion: z.literal(1), operation: z.literal('probe'),
  account: z.object({ realUID: z.number().int(), effectiveUID: z.number().int(), realUser: z.literal('lucienne'), effectiveUser: z.literal('lucienne'),
    consoleUser: z.literal('lucienne'), consoleUID: z.number().int(), consoleDeviceUID: z.number().int(), onConsole: z.literal(true), loginDone: z.literal(true) }),
  finderActivationAllowed: z.literal(true), frontmostPID: z.number().int().optional(), frontmostBundleID: z.string().optional(),
  finderPIDs: z.array(z.number().int()).length(1), screensTruncated: z.literal(false), screenCount: z.number().int().min(1).max(8),
  screens: z.array(z.object({ boundsCG: rect })).min(1).max(8), includingDesktop: inventory, excludingDesktop: inventory,
  windowLevels: z.object({ cursor: z.number().int(), dock: z.number().int(), mainMenu: z.number().int(), status: z.number().int() }).optional(),
});
type Probe = z.infer<typeof DesktopProbeSchema>;
type Window = z.infer<typeof window>;
type Rect = z.infer<typeof rect>;
export interface DesktopBlocker { appId: string; pid: number; layer: number }
export class DesktopObstructedError extends Error {
  readonly blockers: readonly DesktopBlocker[];
  constructor(blockers: DesktopBlocker[]) {
    super('DESKTOP_OBSTRUCTED'); this.name = 'DesktopObstructedError';
    this.blockers = Object.freeze(blockers.map(blocker => Object.freeze({ ...blocker })));
  }
}
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const covers = (a: Rect, b: Rect) => a.x <= b.x + 1 && a.y <= b.y + 1 && a.x + a.width >= b.x + b.width - 1 && a.y + a.height >= b.y + b.height - 1;
const isSystemCursor = (w: Window, probe: Probe) => w.ownerSystemRole === 'window-server' && !!probe.windowLevels &&
  w.layer === probe.windowLevels.cursor && w.boundsCG.width <= 128 && w.boundsCG.height <= 128;
const ignoredForStability = (w: Window, probe: Probe, ignoredPID?: number) =>
  w.ownerPID === ignoredPID || isSystemCursor(w, probe);
const windowIdentity = (w: Window) => JSON.stringify([w.windowID, w.ownerPID, w.ownerBundleID, w.ownerSystemRole,
  w.layer, w.alpha, w.onScreen, w.boundsCG.x, w.boundsCG.y, w.boundsCG.width, w.boundsCG.height]);

/** The helper reads these inventories separately; a moving scene cannot establish desktop visibility. */
function assertConsistentInventories(probe: Probe, ignoredPID?: number): void {
  const including = new Map(probe.includingDesktop.windows.map(w => [w.windowID, w]));
  const excluding = new Map(probe.excludingDesktop.windows.map(w => [w.windowID, w]));
  if (including.size !== probe.includingDesktop.windows.length || excluding.size !== probe.excludingDesktop.windows.length)
    throw new Error('DESKTOP_PROBE_UNAVAILABLE');
  for (const w of probe.excludingDesktop.windows) {
    const other = including.get(w.windowID);
    if (other && ignoredForStability(w, probe, ignoredPID) && ignoredForStability(other, probe, ignoredPID) &&
      w.ownerPID === other.ownerPID && w.ownerSystemRole === other.ownerSystemRole) continue;
    if (!other) {
      if (ignoredForStability(w, probe, ignoredPID)) continue;
      throw new Error('DESKTOP_PROBE_UNAVAILABLE');
    }
    if (windowIdentity(w) !== windowIdentity(other)) throw new Error('DESKTOP_PROBE_UNAVAILABLE');
  }
  for (const w of probe.includingDesktop.windows) {
    if (!excluding.has(w.windowID) && w.layer >= 0 && !ignoredForStability(w, probe, ignoredPID))
      throw new Error('DESKTOP_PROBE_UNAVAILABLE');
  }
}

function stableDesktopIdentity(probe: Probe, ignoredPID?: number): string {
  return JSON.stringify({ account: probe.account, screens: probe.screens, windowLevels: probe.windowLevels,
    frontmostPID: probe.frontmostPID, frontmostBundleID: probe.frontmostBundleID, finderPIDs: probe.finderPIDs,
    including: probe.includingDesktop.windows.filter(w => !ignoredForStability(w, probe, ignoredPID)).map(windowIdentity),
    excluding: probe.excludingDesktop.windows.filter(w => !ignoredForStability(w, probe, ignoredPID)).map(windowIdentity) });
}

/** Fail closed. OS-classified desktop surfaces, bounded system cursors and narrow menu/Dock edges only. */
export function classifyDesktop(value: unknown, ignoredPID?: number): Probe {
  // A reported account/session change is a guard failure, not retryable missing window metadata.
  if (value && typeof value === 'object') {
    if ('account' in value) {
      const account = DesktopProbeSchema.shape.account.safeParse(value.account);
      if (!account.success || !account.data.realUID ||
        ![account.data.effectiveUID, account.data.consoleUID, account.data.consoleDeviceUID].every(id => id === account.data.realUID))
        throw new Error('CONSOLE_CHANGED');
    }
    if ('finderActivationAllowed' in value && value.finderActivationAllowed === false)
      throw new Error('CONSOLE_CHANGED');
  }
  let probe: Probe;
  try { probe = DesktopProbeSchema.parse(value); } catch { throw new Error('DESKTOP_PROBE_UNAVAILABLE'); }
  if (probe.screenCount !== probe.screens.length || [probe.includingDesktop, probe.excludingDesktop].some(i => i.totalCount !== i.windows.length))
    throw new Error('DESKTOP_PROBE_UNAVAILABLE');
  assertConsistentInventories(probe, ignoredPID);
  const excludedIDs = new Set(probe.excludingDesktop.windows.map(w => w.windowID));
  const surfaces = probe.includingDesktop.windows.filter(w => !excludedIDs.has(w.windowID) && w.onScreen && w.alpha > 0 && w.layer < 0);
  if (!probe.screens.every(s => s.boundsCG.width > 0 && s.boundsCG.height > 0 && surfaces.some(w => covers(w.boundsCG, s.boundsCG))))
    throw new Error('DESKTOP_PROBE_UNAVAILABLE');
  const blockers: DesktopBlocker[] = [];
  for (const w of probe.excludingDesktop.windows) {
    if (!w.onScreen || w.alpha === 0 || w.boundsCG.width === 0 || w.boundsCG.height === 0 || w.ownerPID === ignoredPID) continue;
    const visibleOn = probe.screens.filter(s => intersects(w.boundsCG, s.boundsCG));
    if (!visibleOn.length) continue;
    const menu = [24, 25].includes(w.layer) && visibleOn.every(({ boundsCG: s }) =>
      w.boundsCG.y >= s.y - 1 && w.boundsCG.y <= s.y + 1 && w.boundsCG.height <= 80);
    const cursor = isSystemCursor(w, probe);
    const dock = w.ownerBundleID === 'com.apple.dock' && w.ownerSystemRole === 'dock' &&
      w.layer === (probe.windowLevels?.dock ?? 20) && visibleOn.every(({ boundsCG: s }) => {
      const r = w.boundsCG;
      // Modern macOS floats the Dock slightly inside the display boundary.
      // Permit that small inset only for the authenticated system Dock at its
      // dedicated layer, contained in a narrow edge strip.
      const inset = Math.min(32, Math.min(s.width, s.height) * 0.03);
      const contained = r.x >= s.x - 1 && r.y >= s.y - 1 &&
        r.x + r.width <= s.x + s.width + 1 && r.y + r.height <= s.y + s.height + 1;
      return contained && ((r.height <= s.height / 4 && r.y >= s.y + s.height * 0.75 &&
        r.y + r.height >= s.y + s.height - inset) ||
        (r.width <= s.width / 4 && ((r.x <= s.x + inset && r.x + r.width <= s.x + s.width / 4) ||
          (r.x >= s.x + s.width * 0.75 && r.x + r.width >= s.x + s.width - inset))));
    });
    if (!menu && !dock && !cursor) blockers.push({ appId: w.ownerBundleID?.slice(0, 200).replace(/[^A-Za-z0-9._-]/g, '?') || 'unknown',
      pid: w.ownerPID, layer: w.layer });
  }
  if (blockers.length) throw new DesktopObstructedError(blockers);
  return probe;
}

type DesktopSettlingOptions = {
  probe(): Promise<unknown>;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  timeoutMs?: number;
  intervalMs?: number;
  onBlocked?(blockers: DesktopBlocker[]): void;
} & ({ mode: 'preflight'; ownPID: number } | { mode: 'return'; isHidden(): boolean });

/** Two matching accepted samples are required; retries never relax the classifier or account guards. */
export async function waitForStableDesktop(options: DesktopSettlingOptions): Promise<Probe> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 3000;
  const intervalMs = options.intervalMs ?? 150;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= timeoutMs)
    throw new Error('INVALID_DESKTOP_SETTLING_OPTIONS');
  const ignoredPID = options.mode === 'preflight' ? options.ownPID : undefined;
  if (ignoredPID !== undefined && (!Number.isInteger(ignoredPID) || ignoredPID <= 0)) throw new Error('INVALID_DESKTOP_SETTLING_OPTIONS');
  const deadline = now() + timeoutMs;
  let previous: string | undefined;
  let lastFailure: Error | undefined;
  let lastBlocker: DesktopObstructedError | undefined;
  const report = (blockers: readonly DesktopBlocker[]) => {
    try { options.onBlocked?.(blockers.map(blocker => ({ ...blocker }))); } catch { /* Diagnostics cannot own cleanup. */ }
  };
  // The attempt cap also bounds injected clocks that do not advance as expected.
  for (let attempt = 0; attempt <= Math.ceil(timeoutMs / intervalMs) && now() < deadline; attempt++) {
    try {
      const hiddenBefore = options.mode === 'preflight' || options.isHidden();
      const probe = classifyDesktop(await options.probe(), ignoredPID);
      lastBlocker = undefined;
      if (options.mode === 'return' && (!hiddenBefore || !options.isHidden() ||
        probe.frontmostBundleID !== 'com.apple.finder' || probe.frontmostPID !== probe.finderPIDs[0]))
        throw new Error('DESKTOP_RETURN_TIMEOUT');
      const identity = stableDesktopIdentity(probe, ignoredPID);
      if (identity === previous && now() < deadline) { report([]); return probe; }
      previous = identity;
      lastFailure = undefined;
    } catch (error) {
      if (!(error instanceof DesktopObstructedError) && !(error instanceof Error &&
        ['DESKTOP_PROBE_UNAVAILABLE', 'DESKTOP_RETURN_TIMEOUT'].includes(error.message))) throw error;
      previous = undefined;
      lastFailure = error;
      if (error instanceof DesktopObstructedError) { lastBlocker = error; report(error.blockers); }
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw lastBlocker ?? lastFailure ?? new Error('DESKTOP_RETURN_TIMEOUT');
}

export async function assertDedicatedConsole(): Promise<void> {
  if (process.platform !== 'darwin' || userInfo().username !== 'lucienne' || !process.getuid?.() || process.getuid() !== process.geteuid?.() ||
      (await stat('/dev/console')).uid !== process.getuid()) throw new Error('DEDICATED_ACCOUNT_REQUIRED');
}

export interface NativeDesktopPort extends DesktopPort { checkBeforeRun(): Promise<void> }
export function createNativeDesktop(options: { helperPath: string; evidenceDirectory: string;
  hide(): void; showRecovery(): void; isHidden(): boolean; ownPID?: number;
  identity(): { buildId: string; runId: string };
  onBlocked?(blockers: DesktopBlocker[]): void;
  onArtifact(artifact: { id: string; path: string; sha256: string; buildId: string; runId: string; evidenceKind: 'native' }): void;
}): NativeDesktopPort {
  const exec = promisify(execFile);
  const invoke = async (operation: 'probe' | 'activate-finder') => {
    await assertDedicatedConsole();
    const { stdout } = await exec(options.helperPath, [operation], { timeout: 1500, maxBuffer: 262144, encoding: 'utf8' });
    await assertDedicatedConsole();
    return JSON.parse(stdout) as unknown;
  };
  return { async checkBeforeRun() {
    // A nonmutating obstruction check avoids starting inference while known
    // windows would prevent cleanup. This is not the final desktop/reset proof.
    await waitForStableDesktop({ mode: 'preflight', ownPID: options.ownPID ?? process.pid,
      probe: () => invoke('probe'), onBlocked: options.onBlocked });
  }, async returnToDesktop() {
    await assertDedicatedConsole();
    await waitForStableDesktop({ mode: 'preflight', ownPID: options.ownPID ?? process.pid,
      probe: () => invoke('probe'), onBlocked: options.onBlocked });
    options.hide();
    try {
      const activation = await invoke('activate-finder') as { ok?: boolean };
      if (activation.ok !== true) throw new Error('DESKTOP_RETURN_TIMEOUT');
      const last = await waitForStableDesktop({ mode: 'return', isHidden: options.isHidden,
        probe: () => invoke('probe'), onBlocked: options.onBlocked });
      const id = `desktop:${randomUUID()}`;
      const identity = options.identity();
      const file = path.join(options.evidenceDirectory, `${id.slice(8)}.json`);
      const bytes = JSON.stringify({ id, ...identity, evidenceKind: 'native', observedAt: new Date().toISOString(), probe: last }) + '\n';
      await mkdir(options.evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      options.onArtifact({ id, ...identity, path: file, sha256: createHash('sha256').update(bytes).digest('hex'), evidenceKind: 'native' });
      return { desktopVisible: true, evidenceRefs: [id] };
    } catch (error) {
      try { await assertDedicatedConsole(); options.showRecovery(); } catch { /* Never act on a different account. */ }
      throw error;
    }
  } };
}
