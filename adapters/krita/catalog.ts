import { validateRequest, type Capability, type Operation, type PlannerRequest } from '../../contracts/index.js';

export const KRITA_TARGET = Object.freeze({ appId: 'krita' as const, adapterVersion: 'krita-5.3.4-v1' });
export const KRITA_CATALOG: readonly Capability[] = Object.freeze([
  { id: 'krita.binding.brush', kind: 'binding', bindingAction: 'brush', values: ['B'] },
  { id: 'krita.binding.select-rectangle', kind: 'binding', bindingAction: 'select-rectangle', values: ['M'] },
  { id: 'krita.binding.transform', kind: 'binding', bindingAction: 'transform', values: ['Meta+T'] },
  { id: 'krita.layout.panel-side', kind: 'layout', preferenceKey: 'panel-side', values: ['left', 'right'] },
  { id: 'krita.canvas.work-area', kind: 'canvas', preferenceKey: 'work-area', values: ['normal', 'large'] },
  { id: 'krita.tool-layout.density', kind: 'tool-layout', preferenceKey: 'tool-density', values: ['full', 'simple'] },
].map(cap => Object.freeze({ ...cap, values: Object.freeze(cap.values) as unknown as string[] })) as Capability[]);

export function assertKritaRequest(value: PlannerRequest): PlannerRequest {
  const request = validateRequest(value);
  if (request.target.appId !== KRITA_TARGET.appId || request.target.adapterVersion !== KRITA_TARGET.adapterVersion)
    throw new Error('KRITA_WRONG_ADAPTER');
  if (request.catalog.length !== KRITA_CATALOG.length || KRITA_CATALOG.some(expected => {
    const actual = request.catalog.find(c => c.id === expected.id);
    return !actual || actual.kind !== expected.kind || actual.bindingAction !== expected.bindingAction ||
      actual.preferenceKey !== expected.preferenceKey || actual.values.length !== expected.values.length ||
      expected.values.some((value, i) => value !== actual.values[i]);
  })) throw new Error('KRITA_UNTRUSTED_CATALOG');
  return request;
}

/** Initial authored recipe. Live chat is provided by planner service, never simulated here. */
export function resolveKritaRecipe(value: PlannerRequest): { operations: Operation[]; evidenceRefs: string[] } {
  const request = assertKritaRequest(value);
  if (request.kind !== 'translate' || request.source.sourceApp !== 'photoshop') throw new Error('KRITA_RECIPE_UNAVAILABLE');
  const preferences = new Map(request.source.preferences.map(p => [p.key, p.value]));
  request.explicit.forEach(p => preferences.set(p.key, p.value));
  const defaults: Record<string, string> = { 'panel-side': 'left', 'work-area': 'normal', 'tool-density': 'full' };
  const operations = KRITA_CATALOG.map(cap => {
    const requested = cap.bindingAction ? request.source.bindings[cap.bindingAction] : preferences.get(cap.preferenceKey!);
    const value = requested ?? (cap.preferenceKey ? defaults[cap.preferenceKey] : cap.values[0]);
    if (!cap.values.includes(value)) throw new Error('KRITA_RECIPE_UNSUPPORTED_VALUE');
    return { capabilityId: cap.id, value };
  });
  return { operations, evidenceRefs: [...request.evidenceRefs] };
}
