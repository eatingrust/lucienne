import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { LIMITS, PreparationJobs, ServiceError } from './jobs.js';

function reply(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  const data = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(status >= 400 ? { connection: 'close' } : {}) });
  response.end(data);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json'
    || request.headers['content-encoding']) throw new ServiceError(415, 'JSON_REQUIRED');
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.bodyBytes)) throw new ServiceError(413, 'BODY_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let total = 0;
    const cleanup = () => { clearTimeout(timer); request.removeListener('data', onData); request.removeListener('end', onEnd); request.removeListener('error', onError); request.removeListener('aborted', onAbort); };
    const failed = (code: string, status: number) => { cleanup(); request.resume(); reject(new ServiceError(status, code)); };
    const onData = (chunk: Buffer) => { total += chunk.length; if (total > LIMITS.bodyBytes) failed('BODY_TOO_LARGE', 413); else chunks.push(chunk); };
    const onError = () => failed('INVALID_BODY', 400);
    const onAbort = () => failed('REQUEST_ABORTED', 400);
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new ServiceError(400, 'INVALID_JSON')); }
    };
    const timer = setTimeout(() => failed('BODY_TIMEOUT', 408), 5000);
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAbort);
  });
}

export function createPreparationServer(jobs: PreparationJobs, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('PREPARATION_TOKEN_REQUIRED');
  const expected = Buffer.from(`Bearer ${token}`);
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, async (request, response) => {
    try {
      const path = request.url ?? '';
      if (request.method === 'GET' && path === '/healthz') {
        const stopping = closing || jobs.status().stopping;
        reply(response, stopping ? 503 : 200, { version: 1, status: stopping ? 'stopping' : 'ok' }); return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ServiceError(401, 'UNAUTHORIZED');
      // This is a trusted host API. Browser origins and passive-reader tokens are not accepted.
      if (request.headers.origin) throw new ServiceError(403, 'BROWSER_ORIGIN_REJECTED');
      if (closing) throw new ServiceError(503, 'SERVICE_STOPPING');
      if (request.method === 'GET' && path === '/v1/status') { reply(response, 200, jobs.status()); return; }
      if (request.method === 'POST' && path === '/v1/jobs') { reply(response, 202, jobs.submit(await body(request))); return; }
      if (request.method === 'POST' && path === '/v1/attach') { reply(response, 200, jobs.attach(await body(request))); return; }
      const match = /^\/v1\/jobs\/([a-f0-9-]{36})$/.exec(path);
      if (match && request.method === 'GET') { reply(response, 200, jobs.get(match[1])); return; }
      if (match && request.method === 'DELETE') { reply(response, 200, jobs.cancel(match[1])); return; }
      throw new ServiceError(404, 'NOT_FOUND');
    } catch (error) {
      request.resume();
      reply(response, error instanceof ServiceError ? error.status : 500,
        { version: 1, code: error instanceof ServiceError ? error.code : 'INTERNAL_ERROR' });
    }
  });
  server.maxConnections = 32;
  return { server, close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      try { await jobs.close(); } finally { await closed; }
    })();
    return closePromise;
  } };
}
