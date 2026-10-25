import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const [entry, neutral] of [['src/index.tsx', true], ['src/spacetime.tsx', false]]) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    metafile: true, platform: 'browser', format: 'esm', outdir: 'dist/boundary-check', logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some(input => /(?:\/publisher\.ts$|\/spacetime-main\.ts$|\/convex\/|\/telemetry\/|\/core\/(?:session|fixture)\.ts$|\/adapters\/|fixture(?:-main)?\.tsx?$)/.test(input))) {
    throw new Error('COMPANION_AUTHORITY_OR_FIXTURE_LEAK');
  }
  if (neutral && inputs.some(input => /node_modules\/(?:convex|spacetimedb)\//.test(input))) throw new Error('NEUTRAL_PROVIDER_COUPLING');
  const output = result.outputFiles.map(file => file.text).join('\n');
  if (/SessionPublisher|LUCIENNE_SESSION_PRODUCER_TOKEN|LUCIENNE_TIGER_DATABASE_URL|sessions:inspectProducer/.test(output)) throw new Error('PRODUCER_LEAK');
  console.log(`${entry}: passive browser boundary passed`);
}
