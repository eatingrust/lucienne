import fixture from './learning-demo/photoshop-collage.json' with { type: 'json' };
import { SourceProfileSchema } from '../contracts/index.js';
/** Explicit fixture entrypoint, never selected by the live quiz or translation service. */
export function getPresetLearningDemo() {
  const data = structuredClone(fixture);
  const result = SourceProfileSchema.parse(data.result);
  if (result.provenance.mode !== 'simulated' || result.provenance.provider !== 'preset-learning-demo') throw new Error('Invalid learning-demo provenance.');
  return { label: data.label as string, takeaways: data.takeaways as string[], result, limitations: data.limitations as string[] };
}
