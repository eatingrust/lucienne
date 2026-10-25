// Use the exact Opus 5.5 model selected by the planner contract.
// New model IDs require a deliberate verified policy update, never silent fallback.
export const FACTORY_INFERENCE_MODEL = 'claude-opus-5-5';
export function assertFactoryInferenceModel(modelId) {
  if (modelId !== FACTORY_INFERENCE_MODEL) throw new Error('FACTORY_MODEL_NOT_APPROVED');
  return modelId;
}
