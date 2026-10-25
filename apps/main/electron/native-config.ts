import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/** Trusted main-process configuration only. Never accept these paths through IPC. */
export async function readPrivateSecret(file: string): Promise<string> {
  if (!path.isAbsolute(file)) throw new Error('PRIVATE_CONFIG_INVALID');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error('PRIVATE_CONFIG_PERMISSIONS');
    const value = (await handle.readFile('utf8')).trim();
    if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('PRIVATE_CONFIG_INVALID');
    return value;
  } finally { await handle.close(); }
}

export async function nativeSecrets(directory: string, env: NodeJS.ProcessEnv = process.env) {
  const secret = async (variable: string, fileVariable: string, name: string) => {
    if (env[variable]) return env[variable];
    const file = env[fileVariable] ?? path.join(directory, name);
    try { await lstat(file); } catch (error) {
      if (!env[fileVariable] && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('PRIVATE_CONFIG_UNAVAILABLE');
    }
    return readPrivateSecret(file);
  };
  let tigerDatabaseURL: string | undefined;
  let telemetryConfigError = false;
  try { tigerDatabaseURL = await secret('LUCIENNE_TIGER_DATABASE_URL', 'LUCIENNE_TIGER_URL_FILE', 'tiger-url.key'); }
  catch { telemetryConfigError = true; }
  return {
    factoryApiKey: await secret('FACTORY_API_KEY', 'LUCIENNE_FACTORY_KEY_FILE', 'factory.key'),
    claudeApiKey: await secret('ANTHROPIC_API_KEY', 'LUCIENNE_ANTHROPIC_KEY_FILE', 'anthropic.key'),
    tigerDatabaseURL, telemetryConfigError,
    factoryBinary: env.LUCIENNE_DROID_BINARY ?? env.LUCIENNE_FACTORY_BINARY,
    claudeWorkspaceId: env.ANTHROPIC_WORKSPACE_ID,
  };
}
