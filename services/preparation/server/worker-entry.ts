import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { MossClientLike } from '../retrieval.js';
import type { PreparationWorkerTask } from './worker-client.js';

const controller = new AbortController();
let finishing = false;
let started = false;
function configured(name: string): string {
  const value = process.env[name];
  if (!value || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('provider_unavailable');
  return value;
}
async function execute(task: PreparationWorkerTask): Promise<unknown> {
  controller.signal.throwIfAborted();
  if (task.kind === 'context') {
    const projectId = configured('MOSS_PROJECT_ID'), projectKey = configured('MOSS_PROJECT_KEY');
    if (task.retrieval !== 'moss') throw Error();
    const configuredPath = process.env.LUCIENNE_MOSS_SDK_PATH;
    let sdkPath: string;
    if (configuredPath) {
      if (!isAbsolute(configuredPath)) throw new Error('provider_unavailable');
      sdkPath = statSync(configuredPath).isDirectory() ? join(configuredPath, 'dist/index.esm.js') : configuredPath;
    } else sdkPath = createRequire(import.meta.url).resolve('@moss-js/moss');
    sdkPath = realpathSync(sdkPath);
    const sdkRoot = dirname(dirname(sdkPath));
    const sdkPackage = JSON.parse(readFileSync(join(sdkRoot,'package.json'),'utf8'));
    const corePath = realpathSync(createRequire(pathToFileURL(sdkPath)).resolve('@moss-js/moss-core'));
    const corePackage = JSON.parse(readFileSync(join(dirname(corePath),'package.json'),'utf8'));
    if (sdkPackage.name !== '@moss-js/moss' || sdkPackage.version !== '1.21.0'
        || sdkPackage.dependencies?.['@moss-js/moss-core'] !== '0.36.0'
        || sdkPackage.main !== 'dist/index.esm.js' || sdkPath !== realpathSync(join(sdkRoot,'dist/index.esm.js'))
        || corePackage.name !== '@moss-js/moss-core' || corePackage.version !== '0.36.0'
        || corePackage.main !== 'index.js' || corePath !== realpathSync(join(dirname(corePath),'index.js'))) throw new Error('provider_unavailable');
    controller.signal.throwIfAborted();
    const sdk = await import(pathToFileURL(sdkPath).href);
    if (typeof sdk.MossClient !== 'function') throw Error();
    const MossClient = sdk.MossClient as new (id: string, key: string) => MossClientLike;
    const { prepareMossContext } = await import('../retrieval.js');
    return prepareMossContext(task.documents, task.query, () => {
      controller.signal.throwIfAborted();
      const client = new MossClient(projectId, projectKey);
      return {
        async session(name, model) {
          controller.signal.throwIfAborted();
          const session = await client.session(name, model);
          return {
            async addDocs(documents) { controller.signal.throwIfAborted(); const result = await session.addDocs(documents); controller.signal.throwIfAborted(); return result; },
            async query(query, options) { controller.signal.throwIfAborted(); const result = await session.query(query, options); controller.signal.throwIfAborted(); return result; },
            close: () => session.close(),
          };
        },
        close: () => client.close(),
      };
    });
  }
  if (task.kind === 'quiz') {
    const apiKey = configured('ANTHROPIC_API_KEY');
    const [{ createClaudeTransport }, { createQuizModelPort }, { nextQuizTurn }] = await Promise.all([
      import('../../planner/src/claude.js'), import('../quiz-model.js'), import('../quiz.js'),
    ]);
    return nextQuizTurn(createQuizModelPort(createClaudeTransport({ apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID })), task.input, controller.signal);
  }
  if (task.kind === 'image') {
    const apiKey = configured('BITDEER_API_KEY');
    if (typeof task.imageBase64 !== 'string' || task.imageBase64.length > 1_333_336
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(task.imageBase64)) throw Error();
    const image = Buffer.from(task.imageBase64, 'base64');
    if (image.toString('base64') !== task.imageBase64) throw Error();
    const { extractBitdeerImage } = await import('../providers/bitdeer.js');
    return extractBitdeerImage({ image, source: task.source, model: 'zai-org/GLM-5.3-Flash', apiKey },
      { signal: controller.signal, timeoutMs: 30_000, maxOutputTokens: 4096 });
  }
  throw Error();
}
// worker-client makes this entry a POSIX group leader. A lost supervisor cannot
// drain that group, so terminate same-group descendants here as well as this worker.
// This only establishes local cleanup; it cannot prove remote inference stopped.
process.on('disconnect', () => {
  if (finishing) return;
  controller.abort();
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch { /* No owned group: exit this leader below. */ }
  }
  process.exit(1);
});
if (!process.send) process.exitCode = 1;
else process.on('message', async task => {
  if (task && typeof task === 'object' && 'type' in task && task.type === 'cancel') {
    controller.abort();
    if (!started) { finishing = true; process.exitCode = 1; if (process.connected) process.disconnect(); }
    return;
  }
  if (started) return;
  started = true;
  let response: { ok: true; value: unknown } | { ok: false; code: string };
  try {
    const value = await execute(task as PreparationWorkerTask);
    response = { ok: true, value };
    if (Buffer.byteLength(JSON.stringify(response)) > 512 * 1024) response = { ok: false, code: 'worker_response_too_large' };
  } catch (error) {
    response = { ok: false, code: error instanceof Error && error.message === 'provider_unavailable' ? 'provider_unavailable' : 'worker_failed' };
  }
  try {
    process.send!(response, error => {
      finishing = true;
      process.exitCode = error || !response.ok ? 1 : 0;
      if (process.connected) process.disconnect();
    });
  } catch { finishing = true; process.exitCode = 1; if (process.connected) process.disconnect(); }
});
