import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preparePrivateArtifact, sha256 } from '../scripts/prepare-private.mjs';
import { loadPrivateArtifact, parseOptions, privateBinding, startPrivateServer } from '../scripts/private-server.mjs';

const mainFile = 'assets/spacetime-ABC123.js';
const expectedPaths = [
  'index.html', mainFile, 'assets/shared-ABC123.js', 'assets/lazy-ABC123.js',
  'assets/main-ABC123.css', 'assets/shared-ABC123.css', 'assets/mark-ABC123.svg', 'assets/font-ABC123.woff2',
].sort();
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lucienne-private-server-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'dist');
  const files = {
    'spacetime.html': '<!doctype html><script type="module" src="/assets/spacetime-ABC123.js"></script>',
    [mainFile]: 'import "./shared-ABC123.js"; export const load=()=>import("./lazy-ABC123.js");',
    'assets/shared-ABC123.js': 'export const shared = true;',
    'assets/lazy-ABC123.js': 'export const lazy = true;',
    'assets/main-ABC123.css': 'body { color: black; }',
    'assets/shared-ABC123.css': '@font-face {font-family:demo;src:url("/assets/font-ABC123.woff2")}',
    'assets/mark-ABC123.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/font-ABC123.woff2': 'fixture-font-bytes',
    'index.html': '<script src="/assets/bootstrap-123.js"></script>',
    'assets/bootstrap-123.js': 'NEUTRAL_ENTRY_MUST_NOT_COPY',
    'fixture.html': '<script src="/assets/fixture-123.js"></script>',
    'assets/fixture-123.js': 'FIXTURE_ENTRY_MUST_NOT_COPY',
    'assets/orphan-123.js': 'UNRELATED_ASSET_MUST_NOT_COPY',
    'assets/spacetime-ABC123.js.map': 'SOURCE_MAP_MUST_NOT_COPY',
    '.private/runtime.json': 'PRIVATE_CONFIG_MUST_NOT_COPY',
  };
  for (const [relative, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(dist, relative)), { recursive: true });
    await writeFile(join(dist, relative), bytes);
  }
  // Vite HTML entry keys point to emitted JS, with emitted HTML copied separately.
  const manifest = {
    'spacetime.html': { file: mainFile, src: 'spacetime.html', isEntry: true,
      imports: ['_shared.js'], dynamicImports: ['src/lazy.ts'],
      css: ['assets/main-ABC123.css'], assets: ['assets/mark-ABC123.svg'] },
    '_shared.js': { file: 'assets/shared-ABC123.js', css: ['assets/shared-ABC123.css'], assets: ['assets/font-ABC123.woff2'] },
    'src/lazy.ts': { file: 'assets/lazy-ABC123.js', isDynamicEntry: true, imports: ['_shared.js'] },
    'index.html': { file: 'assets/bootstrap-123.js', src: 'index.html', isEntry: true },
    'fixture.html': { file: 'assets/fixture-123.js', src: 'fixture.html', isEntry: true },
  };
  const saveManifest = async () => {
    await mkdir(join(dist, '.vite'), { recursive: true });
    await writeFile(join(dist, '.vite/manifest.json'), JSON.stringify(manifest));
  };
  await saveManifest();
  return { root, dist, files, manifest, saveManifest };
}
async function artifact(t) {
  const data = await fixture(t);
  const prepared = await preparePrivateArtifact(data.dist);
  return { ...data, ...prepared };
}
async function rewriteArtifact(directory, change) {
  const path = join(directory, 'artifact.json');
  const metadata = JSON.parse(await readFile(path, 'utf8'));
  change(metadata);
  metadata.assetVersion = sha256(JSON.stringify(metadata.files));
  await writeFile(path, JSON.stringify(metadata));
}
function get(running, path = '/', options = {}) {
  const url = new URL(running.url);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: Number(url.port), path, method: options.method ?? 'GET',
      headers: { Host: url.host, Connection: 'close', ...options.headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('fixture HTTP timeout')));
    req.end();
  });
}
function rawRequest(running, target, headers) {
  const url = new URL(running.url);
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = connect({ host: '127.0.0.1', port: Number(url.port) }, () => {
      socket.write(`GET ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\nConnection: close\r\n\r\n`);
    });
    socket.setEncoding('utf8');
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', reject);
    socket.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1]), raw: response }));
    socket.setTimeout(2_000, () => socket.destroy(new Error('fixture raw HTTP timeout')));
  });
}
async function runningArtifact(t) {
  const prepared = await artifact(t);
  const running = await startPrivateServer({ directory: prepared.directory, port: 0 });
  t.after(() => running.close());
  return { ...prepared, running };
}

test('packager copies only the complete production graph and remaps its HTML entry', async t => {
  const prepared = await artifact(t);
  const loaded = await loadPrivateArtifact(prepared.directory);
  assert.deepEqual([...loaded.files.keys()].sort(), expectedPaths.map(path => '/' + path).sort());
  assert.equal(prepared.fileCount, expectedPaths.length);
  assert.equal(loaded.assetVersion, prepared.assetVersion);
  assert.equal(loaded.files.get('/index.html').bytes.toString(), prepared.files['spacetime.html']);
  assert.equal(loaded.files.has('/artifact.json'), false, 'integrity metadata is never a public route');
  const disk = (await readdir(prepared.directory, { recursive: true })).sort();
  assert.deepEqual(disk, ['artifact.json', 'assets', ...expectedPaths].sort());
  assert.doesNotMatch([...loaded.files.values()].map(file => file.bytes.toString()).join('\n'), /MUST_NOT_COPY/);
  const repeat = await preparePrivateArtifact(prepared.dist);
  assert.equal(repeat.assetVersion, prepared.assetVersion, 'same inputs produce the same artifact identity');
});

test('packager rejects missing dependencies, other entries, source maps and malformed graph references', async t => {
  for (const invalid of ['missing', 'fixture', 'neutral', 'map', 'nonstrings', 'traversal']) {
    await t.test(invalid, async t => {
      const data = await fixture(t);
      const entry = data.manifest['spacetime.html'];
      if (invalid === 'missing') entry.imports = ['missing-node'];
      if (invalid === 'fixture') entry.imports = ['fixture.html'];
      if (invalid === 'neutral') entry.imports = ['index.html'];
      if (invalid === 'map') entry.assets = ['assets/spacetime-ABC123.js.map'];
      if (invalid === 'nonstrings') entry.imports = [42];
      if (invalid === 'traversal') entry.assets = ['assets/../../.private/runtime.json'];
      await data.saveManifest();
      await assert.rejects(preparePrivateArtifact(data.dist));
    });
  }
});

test('packager refuses an asset symlink even when its target is inside the dist tree', async t => {
  const data = await fixture(t);
  await rm(join(data.dist, mainFile));
  await symlink(join(data.dist, 'assets/shared-ABC123.js'), join(data.dist, mainFile));
  await assert.rejects(preparePrivateArtifact(data.dist), /INVALID_PRODUCT_ARTIFACT/);
});

test('loader rejects tampered bytes, missing files, symlinks and unsafe listed files before serving', async t => {
  for (const invalid of ['bytes', 'missing', 'symlink', 'metadata-hash', 'unknown', 'map', 'duplicate']) {
    await t.test(invalid, async t => {
      const data = await artifact(t);
      if (invalid === 'bytes') await writeFile(join(data.directory, mainFile), 'tampered');
      if (invalid === 'missing') await rm(join(data.directory, mainFile));
      if (invalid === 'symlink') {
        await rm(join(data.directory, mainFile));
        await symlink(join(data.dist, mainFile), join(data.directory, mainFile));
      }
      if (invalid === 'metadata-hash') {
        const path = join(data.directory, 'artifact.json');
        const meta = JSON.parse(await readFile(path, 'utf8'));
        meta.assetVersion = '0'.repeat(64);
        await writeFile(path, JSON.stringify(meta));
      }
      if (invalid === 'unknown' || invalid === 'map') {
        const relative = invalid === 'unknown' ? '.private/runtime.json' : 'assets/debug.js.map';
        await mkdir(dirname(join(data.directory, relative)), { recursive: true });
        await writeFile(join(data.directory, relative), 'not public');
        await rewriteArtifact(data.directory, meta => meta.files.push({ path: relative, bytes: 10, sha256: sha256('not public') }));
      }
      if (invalid === 'duplicate') await rewriteArtifact(data.directory, meta => meta.files.push(meta.files[0]));
      await assert.rejects(loadPrivateArtifact(data.directory));
    });
  }
});

test('private bind permits exact loopback or an assigned RFC1918 interface and its subnet peers only', () => {
  const interfaces = { thunderbolt: [{ family: 'IPv4', address: '192.168.40.1', netmask: '255.255.255.0', internal: false }] };
  const loopback = privateBinding('127.0.0.1', interfaces);
  assert.equal(loopback.accepts('127.0.0.1'), true);
  assert.equal(loopback.accepts('192.168.40.2'), false);
  const direct = privateBinding('192.168.40.1', interfaces);
  assert.equal(direct.accepts('192.168.40.2'), true);
  for (const peer of ['192.168.41.2', '127.0.0.1', '10.0.0.2', '8.8.8.8', '::ffff:192.168.40.2', 'example.com']) {
    assert.equal(direct.accepts(peer), false, peer);
  }
  for (const host of ['0.0.0.0', '::', '::1', 'localhost', '127.0.0.2', '8.8.8.8', '169.254.1.1', '172.15.0.1', '172.32.0.1', '100.64.0.1', '192.168.40.999']) {
    assert.throws(() => privateBinding(host, interfaces), /PRIVATE_BIND_ADDRESS_REQUIRED/, host);
  }
  assert.throws(() => privateBinding('192.168.41.1', interfaces), /PRIVATE_INTERFACE_UNAVAILABLE/);
  for (const host of ['10.0.0.1', '172.16.0.1', '172.31.0.1']) {
    assert.equal(privateBinding(host, { lan: [{ family: 'IPv4', address: host, netmask: '255.255.255.0' }] }).host, host);
  }
});

test('CLI accepts only explicit bind/port options and cannot choose an arbitrary file root', () => {
  assert.deepEqual(parseOptions([]), { host: '127.0.0.1', port: 4318 });
  assert.deepEqual(parseOptions(['--host', '192.168.40.1', '--port', '4319']), { host: '192.168.40.1', port: 4319 });
  for (const args of [['--root', '/'], ['--directory', '/'], ['--host'], ['--port', '0'], ['--port', '65536'], ['--port', '4318x'], ['--port', 'Infinity'], ['../'], ['--port', '4318', '/']]) {
    assert.throws(() => parseOptions(args), /USAGE/);
  }
});

test('GET/HEAD serve finite verified bytes with strict headers and never expose integrity metadata', async t => {
  const { running, files } = await runningArtifact(t);
  const page = await get(running);
  assert.equal(page.status, 200);
  assert.equal(page.body.toString(), files['spacetime.html']);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['x-lucienne-asset-version'], running.assetVersion);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['content-security-policy'], /img-src 'self' data:/);
  assert.match(page.headers['content-security-policy'], /connect-src wss:\/\/maincloud\.spacetimedb\.com https:\/\/maincloud\.spacetimedb\.com/);
  assert.equal((await get(running, '/index.html')).body.toString(), page.body.toString());
  assert.equal((await get(running, '/spacetime.html')).body.toString(), page.body.toString());
  const head = await get(running, '/' + mainFile, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(files[mainFile]));
  assert.equal(head.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal((await get(running, '/artifact.json')).status, 404);
  const post = await get(running, '/', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('server rejects unknown/query/encoded/traversal paths and wrong or duplicated Host authority', async t => {
  const { running, directory } = await runningArtifact(t);
  await writeFile(join(directory, 'private-secret.json'), 'UNSERVED_PRIVATE_MARKER');
  for (const path of ['/private-secret.json', '/fixture.html', '/assets/fixture-123.js', '/.vite/manifest.json', '/src/controller.ts', '/.private/runtime.json', '/?code=secret', '/?', '/#secret', '/index.html?', '//index.html', '/%69ndex.html', '/assets/%2e%2e/index.html', '/assets/../index.html', '/assets\\..\\index.html', '/assets/', '/assets/spacetime-ABC123.js.map']) {
    const result = await get(running, path);
    assert.equal(result.status, 404, path);
    assert.doesNotMatch(result.body.toString(), /UNSERVED_PRIVATE_MARKER/);
  }
  for (const host of ['example.com', 'localhost', '127.0.0.1:1', new URL(running.url).host + '.']) {
    assert.equal((await get(running, '/', { headers: { Host: host } })).status, 403, host);
  }
  const authority = new URL(running.url).host;
  assert.equal((await rawRequest(running, '/', [`Host: ${authority}`, 'Host: attacker.invalid'])).status, 403);
  assert.equal((await rawRequest(running, '/', [`Host: ${authority}`, `hOsT: ${authority}`])).status, 403);
  assert.equal((await rawRequest(running, `http://${authority}/index.html`, [`Host: ${authority}`])).status, 404);
});

test('server holds verified immutable bytes after startup and cannot load newly added files', async t => {
  const { running, directory, files } = await runningArtifact(t);
  await writeFile(join(directory, mainFile), 'REPLACED_AFTER_STARTUP');
  await writeFile(join(directory, 'assets/new.js'), 'ADDED_AFTER_STARTUP');
  await rm(join(directory, 'index.html'));
  await writeFile(join(directory, 'artifact.json'), '{}');
  const script = await get(running, '/' + mainFile);
  assert.equal(script.status, 200);
  assert.equal(script.body.toString(), files[mainFile]);
  assert.equal(script.headers['x-lucienne-asset-version'], running.assetVersion);
  assert.equal((await get(running, '/')).body.toString(), files['spacetime.html']);
  assert.equal((await get(running, '/assets/new.js')).status, 404);
});
