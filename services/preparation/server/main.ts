import { readServiceConfig } from './config.js';
import { PreparationJobs } from './jobs.js';
import { createPreparationServer } from './http.js';
import { loadApifyArtifact } from './apify-artifact.js';

async function main() {
  const config = readServiceConfig();
  const apifyDocuments = config.apifyArtifact ? loadApifyArtifact(config.apifyArtifact.path, config.apifyArtifact.sha256) : undefined;
  const jobs = new PreparationJobs({ capabilities: config.capabilities, workerEnv: config.workerEnv, apifyDocuments });
  const app = createPreparationServer(jobs, config.token);
  let shutdown: Promise<void> | undefined;
  const stop = () => { shutdown ??= app.close().then(() => { process.exitCode = 0; }, () => {
    process.stderr.write('PREPARATION_STOP_FAILED\n'); process.exitCode = 1;
  }); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => resolve());
  });
  // No addresses, payloads, credentials or provider diagnostics in service logs.
  process.stdout.write(JSON.stringify({ event: 'preparation-ready', version: 1 }) + '\n');
}
main().catch(() => { process.stderr.write('PREPARATION_START_FAILED\n'); process.exitCode = 1; });
