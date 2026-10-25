import { build as bundle } from 'esbuild';
import { build as renderer } from 'vite';
import { readdir, mkdir, copyFile, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixtureOnly = process.argv.includes('--fixture-only');

for (const output of ['dist/electron', 'dist/contracts', 'dist/services/planner', 'dist/services/preparation', 'dist/profiles', 'dist/adapters', 'dist/native', 'dist/build.json']) {
  await rm(output, { recursive: true, force: true });
}
await renderer({ configFile: 'vite.config.ts' });
await bundle({ entryPoints: ['apps/main/electron/main.ts', 'apps/main/electron/preload.ts'],
  outdir: 'dist/electron', bundle: true, platform: 'node', format: 'cjs',
  outExtension: { '.js': '.cjs' }, external: ['electron', 'pg'], target: 'node22', sourcemap: true });

// Preserve both services' ESM file layouts: import.meta.url must point at each
// packaged fixed worker. Main loads these sidecars dynamically, outside its CJS bundle.
const runtimeDirectories = ['contracts', 'services/planner/src', 'services/preparation',
  'services/preparation/server', 'services/preparation/providers',
  'adapters/krita', 'adapters/blender', 'adapters/reaper', 'adapters/kdenlive'];
const entryPoints = ['profiles/index.ts'];
for (const directory of runtimeDirectories) {
  for (const name of await readdir(directory)) {
    if (directory === 'services/preparation/server' && name === 'smoke.ts') continue;
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) entryPoints.push(`${directory}/${name}`);
  }
}
await bundle({ entryPoints, outdir: 'dist', outbase: '.', bundle: false,
  platform: 'node', format: 'esm', target: 'node22', sourcemap: true });
// Exact runtime data imports only; never copy the broader evidence or notes trees.
for (const file of ['profiles/personas.json',
  'profiles/reference/photoshop-krita.docs.json',
  'profiles/reference/source-bindings.json']) {
  await mkdir(path.dirname(`dist/${file}`), { recursive: true });
  await copyFile(file, `dist/${file}`);
}
const factory = 'services/planner/src/factory';
await mkdir(`dist/${factory}`, { recursive: true });
for (const name of await readdir(factory)) {
  if (name.endsWith('.mjs')) await copyFile(`${factory}/${name}`, `dist/${factory}/${name}`);
}
await cp('adapters/krita/plugin', 'dist/adapters/krita/plugin', { recursive: true });
for (const [directory, files] of [
  ['adapters/blender/native', ['bootstrap.py', 'bridge.py', 'protocol.py']],
  ['adapters/reaper/native', ['bridge.lua', 'bridge_core.lua', 'protocol.lua', 'actions.lua']],
]) {
  await mkdir(`dist/${directory}`, { recursive: true });
  for (const file of files) await copyFile(`${directory}/${file}`, `dist/${directory}/${file}`);
}
await copyFile('adapters/blender/catalog.json', 'dist/adapters/blender/catalog.json');
await mkdir('dist/native', { recursive: true });
for (const [source, output, flags] of fixtureOnly ? [] : [
  ['apps/main/native/desktop-probe.swift', 'desktop-probe', ['-parse-as-library']],
  ['adapters/blender/macos-window-probe.swift', 'blender-window-probe', ['-parse-as-library', '-O']],
  ['adapters/reaper/probe/readiness.swift', 'reaper-readiness', []],
  ['adapters/kdenlive/native/observe.swift', 'kdenlive-observe', ['-O']],
  ['adapters/kdenlive/native/press-menu.swift', 'kdenlive-press-menu', ['-O']],
]) {
  await promisify(execFile)('/usr/bin/xcrun', ['swiftc', ...flags, '-module-cache-path',
    path.join(tmpdir(), 'lucienne-desktop-module-cache'), source, '-o', `dist/native/${output}`],
    { timeout: 60_000, maxBuffer: 262144 });
}

// Build identity describes the emitted runtime and pinned dependencies, not Git notes.
const digest = createHash('sha256');
async function hashDirectory(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await hashDirectory(file);
    else if (entry.isFile()) digest.update(file).update(await readFile(file));
    else throw new Error('BUILD_OUTPUT_NOT_REGULAR');
  }
}
await hashDirectory('dist');
digest.update(await readFile('package-lock.json'));
await writeFile('dist/build.json', JSON.stringify({ buildId: `sha256:${digest.digest('hex')}` }) + '\n');
