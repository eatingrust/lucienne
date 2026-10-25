import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const artifactName = 'private-companion';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const assetPath = value => typeof value === 'string' && /^assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css|svg|png|woff2?)$/.test(value);
const entryKey = 'spacetime.html';
const fail = () => { throw new Error('INVALID_PRODUCT_ARTIFACT'); };

export async function readRegular(root, relative) {
  if (relative !== 'index.html' && relative !== entryKey && relative !== 'artifact.json' && !assetPath(relative)) fail();
  const base = await realpath(root), file = join(base, relative);
  const canonical = await realpath(file);
  if (!canonical.startsWith(base + sep) || canonical !== file || !(await lstat(file)).isFile()) fail();
  return readFile(file);
}

/** Only the accepted Spacetime entry and its Vite dependency graph cross this boundary. */
export async function preparePrivateArtifact(dist) {
  const manifest = JSON.parse(await readFile(join(dist, '.vite/manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || manifest[entryKey]?.isEntry !== true || manifest[entryKey].src !== entryKey) fail();
  const files = new Set([entryKey]), visited = new Set();
  const visit = key => {
    if (typeof key !== 'string') fail();
    if (visited.has(key)) return;
    if (key !== entryKey && /(?:fixture|bootstrap|index\.html)/i.test(key)) fail();
    const chunk = manifest[key];
    if (!chunk || typeof chunk !== 'object' || (key !== entryKey && chunk.isEntry)) fail();
    visited.add(key);
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      if (file !== entryKey && (!assetPath(file) || /fixture/i.test(file))) fail();
      files.add(file);
    }
    for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(dependency);
  };
  visit(entryKey);
  const output = join(dist, artifactName), staging = join(dist, `${artifactName}.staging-${process.pid}`);
  await mkdir(staging, { recursive: false });
  try {
    const entries = [];
    for (const source of [...files].sort()) {
      const bytes = await readRegular(dist, source);
      const path = source === entryKey ? 'index.html' : source;
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), bytes, { flag: 'wx' });
      entries.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
    const assetVersion = sha256(JSON.stringify(entries));
    const artifact = { version: 1, entry: 'index.html', assetVersion, files: entries };
    await writeFile(join(staging, 'artifact.json'), JSON.stringify(artifact, null, 2) + '\n', { flag: 'wx' });
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return { assetVersion, fileCount: entries.length, directory: output };
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  try { console.log(JSON.stringify(await preparePrivateArtifact(dist))); }
  catch { console.error('PRIVATE_ARTIFACT_BUILD_FAILED'); process.exitCode = 1; }
}
