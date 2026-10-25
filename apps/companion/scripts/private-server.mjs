import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactName, assetPath, readRegular, sha256 } from './prepare-private.mjs';

const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', woff: 'font/woff', woff2: 'font/woff2' };
const ipNumber = value => value.split('.').reduce((n, octet) => (n * 256 + Number(octet)) >>> 0, 0);
const isLoopback = host => host === '127.0.0.1';
const isPrivate = host => /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);

export function privateBinding(host, interfaces = networkInterfaces()) {
  if (isIP(host) !== 4 || (!isLoopback(host) && !isPrivate(host))) throw new Error('PRIVATE_BIND_ADDRESS_REQUIRED');
  if (isLoopback(host)) return { host, accepts: address => address === '127.0.0.1' };
  const iface = Object.values(interfaces).flat().find(row => row?.family === 'IPv4' && row.address === host);
  if (!iface || isIP(iface.netmask) !== 4) throw new Error('PRIVATE_INTERFACE_UNAVAILABLE');
  const mask = ipNumber(iface.netmask), subnet = ipNumber(host) & mask;
  if (!/^1+0*$/.test(mask.toString(2).padStart(32, '0'))) throw new Error('PRIVATE_INTERFACE_UNAVAILABLE');
  // Only directly connected peers on the selected interface's subnet may read assets.
  return { host, accepts: address => isIP(address) === 4 && isPrivate(address) && (ipNumber(address) & mask) === subnet };
}

export async function loadPrivateArtifact(directory) {
  const manifest = JSON.parse((await readRegular(directory, 'artifact.json')).toString('utf8'));
  if (manifest.version !== 1 || manifest.entry !== 'index.html' || !Array.isArray(manifest.files) ||
      manifest.files.length < 2 || manifest.files.length > 64 || sha256(JSON.stringify(manifest.files)) !== manifest.assetVersion) throw new Error('INVALID_PRODUCT_ARTIFACT');
  const files = new Map();
  let total = 0;
  for (const file of manifest.files) {
    if (typeof file !== 'object' || !file || (file.path !== 'index.html' && !assetPath(file.path)) ||
        /fixture/i.test(file.path) || files.has('/' + file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 8_000_000) throw new Error('INVALID_PRODUCT_ARTIFACT');
    const bytes = await readRegular(directory, file.path);
    total += bytes.length;
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256 || total > 16_000_000) throw new Error('INVALID_PRODUCT_ARTIFACT');
    files.set('/' + file.path, { bytes, type: types[file.path.split('.').at(-1)] });
  }
  if (!files.has('/index.html')) throw new Error('INVALID_PRODUCT_ARTIFACT');
  return { assetVersion: manifest.assetVersion, files };
}

/** Static-only. Requests never become filesystem paths, commands, logs or backend calls. */
export async function startPrivateServer({ directory, host = '127.0.0.1', port = 4318 }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  const binding = privateBinding(host), artifact = await loadPrivateArtifact(directory);
  let authority;
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src wss://maincloud.spacetimedb.com https://maincloud.spacetimedb.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('X-Lucienne-Asset-Version', artifact.assetVersion);
    const end = (status, text) => { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(request.method === 'HEAD' ? undefined : text); };
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '';
    const hostCount = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length;
    if (!binding.accepts(peer) || hostCount !== 1 || request.headers.host !== authority) { end(403, 'Forbidden'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); end(405, 'Method not allowed'); return; }
    // Exact string lookup rejects queries, fragments, encodings, traversal and directory listings.
    const url = request.url;
    const path = url === '/' || url === '/spacetime.html' ? '/index.html' : url;
    const file = artifact.files.get(path);
    if (!file) { end(404, 'Not found'); return; }
    response.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.bytes.length });
    response.end(request.method === 'HEAD' ? undefined : file.bytes);
  });
  server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 2_000;
  server.maxHeadersCount = 32;
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen({ host, port, exclusive: true }, resolveReady); });
  const address = server.address();
  authority = `${host}:${address.port}`;
  return { server, url: `http://${authority}/spacetime.html`, assetVersion: artifact.assetVersion,
    close: () => new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); }) };
}

export function parseOptions(args) {
  const options = { host: '127.0.0.1', port: 4318 };
  for (let i = 0; i < args.length; i += 2) {
    if (!['--host', '--port'].includes(args[i]) || !args[i + 1]) throw new Error('USAGE');
    if (args[i] === '--host') options.host = args[i + 1];
    else if (/^\d+$/.test(args[i + 1])) options.port = Number(args[i + 1]); else throw new Error('USAGE');
  }
  if (options.port < 1024 || options.port > 65535) throw new Error('USAGE');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const directory = join(fileURLToPath(new URL('../dist', import.meta.url)), artifactName);
    const running = await startPrivateServer({ directory, ...parseOptions(process.argv.slice(2)) });
    console.log(JSON.stringify({ status: 'serving-private-static', url: running.url, assetVersion: running.assetVersion }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void running.close().then(() => process.exit(0)); });
  } catch (error) { console.error(error?.code === 'EADDRINUSE' ? 'PRIVATE_PORT_IN_USE' : 'PRIVATE_SERVER_START_FAILED'); process.exitCode = 1; }
}
