export interface PreparationProviderConfig {
  capabilities: { moss: boolean; quiz: boolean; image: boolean };
  workerEnv: NodeJS.ProcessEnv;
  apifyArtifact?: { path: string; sha256: string };
}
export interface ServiceConfig extends PreparationProviderConfig { host: string; port: number; token: string }

/** Same explicit provider opt-ins for local main-process hosting and the HTTP server. */
export function readPreparationProviderConfig(env: NodeJS.ProcessEnv = process.env): PreparationProviderConfig {
  const enabled = (name: string) => {
    if (env[name] !== undefined && env[name] !== '0' && env[name] !== '1') throw new Error('INVALID_PROVIDER_FLAG');
    return env[name] === '1';
  };
  const capabilities = {
    moss: enabled('LUCIENNE_PREPARATION_MOSS'),
    quiz: enabled('LUCIENNE_PREPARATION_QUIZ'),
    image: enabled('LUCIENNE_PREPARATION_BITDEER'),
  };
  const secret = (name: string) => typeof env[name] === 'string' && /^[!-~]{8,8192}$/.test(env[name]!);
  if (capabilities.moss && (!secret('MOSS_PROJECT_KEY') || !env.MOSS_PROJECT_ID || /\s/.test(env.MOSS_PROJECT_ID))) throw new Error('MOSS_CONFIG_REQUIRED');
  if (capabilities.quiz && !secret('ANTHROPIC_API_KEY')) throw new Error('QUIZ_CONFIG_REQUIRED');
  if (capabilities.image && !secret('BITDEER_API_KEY')) throw new Error('BITDEER_CONFIG_REQUIRED');
  const artifactPath = env.LUCIENNE_PREPARATION_APIFY_CORPUS_FILE;
  const artifactHash = env.LUCIENNE_PREPARATION_APIFY_CORPUS_SHA256;
  if ((artifactPath || artifactHash) && (!artifactPath?.startsWith('/') || !artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash))) throw new Error('INVALID_APIFY_ARTIFACT_CONFIG');
  return { capabilities, workerEnv: { ...env },
    ...(artifactPath && artifactHash ? { apifyArtifact: { path: artifactPath, sha256: artifactHash } } : {}) };
}

/** Explicit host configuration only; secrets are never accepted from HTTP callers. */
export function readServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const token = env.LUCIENNE_PREPARATION_TOKEN ?? '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('PREPARATION_TOKEN_REQUIRED');
  const host = env.LUCIENNE_PREPARATION_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0'].includes(host)) throw new Error('INVALID_PREPARATION_HOST');
  const portText = env.LUCIENNE_PREPARATION_PORT ?? '8787';
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PREPARATION_PORT');
  return { host, port, token, ...readPreparationProviderConfig(env) };
}
