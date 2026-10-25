import { z } from 'zod';
import type { Operation } from '../../contracts/index.js';
import { nativeBindings } from './catalog.js';
import type { ObservationRules } from './observation.js';
export interface LayoutRecipe {
  side: 'left' | 'right'; area: 'normal' | 'large'; tools: 'full' | 'simple';
  stateBase64: string; menuTitle: string;
  toolbarCommands: {title: string; checked: boolean}[];
}
/** Populated ONLY from the serialized native calibration slot, never by an LLM. */
export interface KdenliveCalibration {
  version: 1; appVersion: '24.08.1'; evidenceKind: 'native'; evidenceRefs: string[];
  layouts: LayoutRecipe[]; observations: ObservationRules;
  // Complete native shortcut inventory captured from Configure Shortcuts.
  // Required to clear collisions; a partial source file is not sufficient.
  defaultShortcuts: Record<string, string[]>;
  defaultShortcutsComplete: true;
}
const selector = z.strictObject({role:z.string().regex(/^AX[A-Za-z]+$/),title:z.string().min(1).max(200).optional(),description:z.string().min(1).max(200).optional(),identifier:z.string().min(1).max(200).optional()}).refine(s=>!!(s.title || s.description || s.identifier));
const geometry = z.strictObject({capabilityId:z.enum(['kdenlive.layout.panel-side','kdenlive.timeline.work-area']),value:z.enum(['left','right','normal','large']),selector,axis:z.enum(['center-x','height-ratio','width-ratio']),min:z.number().finite().min(0).max(1),max:z.number().finite().min(0).max(1)}).refine(r=>r.min<r.max && (r.capabilityId==='kdenlive.layout.panel-side' ? ['left','right'].includes(r.value) : ['normal','large'].includes(r.value)));
const calibrationSchema = z.strictObject({
  version:z.literal(1), appVersion:z.literal('24.08.1'), evidenceKind:z.literal('native'), evidenceRefs:z.array(z.string().regex(/^[A-Za-z0-9._:/-]{1,160}$/)).min(1).max(32),
  defaultShortcutsComplete:z.literal(true),defaultShortcuts:z.record(z.string().min(1).max(160),z.array(z.string().min(1).max(80)).max(8)),
  layouts:z.array(z.strictObject({side:z.enum(['left','right']),area:z.enum(['normal','large']),tools:z.enum(['full','simple']),stateBase64:z.string(),menuTitle:z.string().min(1).max(160),toolbarCommands:z.array(z.strictObject({title:z.string().min(1).max(160),checked:z.boolean()})).max(4)})).length(8),
  observations:z.strictObject({geometry:z.array(geometry).min(4).max(12),toggles:z.array(z.strictObject({capabilityId:z.literal('kdenlive.tool-layout.density'),value:z.enum(['full','simple']),selector,checked:z.boolean()})).min(2).max(8),bindings:z.array(z.strictObject({capabilityId:z.enum(['kdenlive.binding.select','kdenlive.binding.razor-tool','kdenlive.binding.blade-tool','kdenlive.binding.play-pause','kdenlive.binding.preview-toggle','kdenlive.binding.mark-in']),menuTitle:z.string().min(1).max(160)})).max(6),interactiveControls:z.array(selector).min(2).max(8)})
});
export function assertCalibration(value: KdenliveCalibration): void {
  if (!calibrationSchema.safeParse(value).success) throw new Error('KDENLIVE_NATIVE_CALIBRATION_REQUIRED');
  if (value.version !== 1 || value.appVersion !== '24.08.1' || value.evidenceKind !== 'native' || !value.evidenceRefs.length ||
      !value.defaultShortcutsComplete || Object.keys(value.defaultShortcuts).length < 50)
    throw new Error('KDENLIVE_NATIVE_CALIBRATION_REQUIRED');
  const combinations = new Set(value.layouts.map(l => `${l.side}/${l.area}/${l.tools}`));
  if (combinations.size !== 8 || value.layouts.length !== 8 || value.layouts.some(l => !/^[A-Za-z0-9+/]+={0,2}$/.test(l.stateBase64) ||
      l.stateBase64.length < 100 || l.stateBase64.length > 100_000 || l.menuTitle.length > 160 || !l.menuTitle || l.toolbarCommands.length > 4))
    throw new Error('KDENLIVE_CALIBRATION_LAYOUTS');
  for (const side of ['left', 'right']) for (const area of ['normal', 'large']) for (const tools of ['full', 'simple'])
    if (!combinations.has(`${side}/${area}/${tools}`)) throw new Error('KDENLIVE_CALIBRATION_LAYOUTS');
  if (value.layouts.some((l,i)=>l.menuTitle!==`Layout ${i+1}: lucienne_${i+1}`)) throw new Error('KDENLIVE_CALIBRATION_MENU_IDENTITY');
  const bindings = value.observations.bindings.map(b=>b.capabilityId);
  const requiredBindings = ['select','razor-tool','blade-tool','play-pause','preview-toggle','mark-in'].map(a=>`kdenlive.binding.${a}`);
  if (bindings.length!==6 || new Set(bindings).size!==6 || requiredBindings.some(id=>!bindings.includes(id))) throw new Error('KDENLIVE_CALIBRATION_READBACK');
  const observed = [...value.observations.geometry,...value.observations.toggles].map(r=>`${r.capabilityId}:${r.value}`);
  for (const expected of ['kdenlive.layout.panel-side:left','kdenlive.layout.panel-side:right','kdenlive.timeline.work-area:normal','kdenlive.timeline.work-area:large','kdenlive.tool-layout.density:full','kdenlive.tool-layout.density:simple']) if(!observed.includes(expected)) throw new Error('KDENLIVE_CALIBRATION_READBACK');
  if (value.observations.interactiveControls.length < 2 || value.observations.geometry.length < 4 || value.observations.toggles.length < 2)
    throw new Error('KDENLIVE_CALIBRATION_READBACK');
}
export function chooseLayout(calibration: KdenliveCalibration, operations: readonly Operation[]): LayoutRecipe {
  assertCalibration(calibration);
  const get = (id: string) => operations.find(op => op.capabilityId === id)?.value;
  const recipe = calibration.layouts.find(l => l.side === get('kdenlive.layout.panel-side') && l.area === get('kdenlive.timeline.work-area') && l.tools === get('kdenlive.tool-layout.density'));
  if (!recipe) throw new Error('KDENLIVE_MISSING_LAYOUT');
  return recipe;
}
export function layoutsConfig(calibration: KdenliveCalibration): string {
  assertCalibration(calibration);
  return '[Layouts]\n' + calibration.layouts.map((l, i) => `lucienne_${i + 1}=${l.stateBase64}`).join('\n') + '\n\n[Order]\n' +
    calibration.layouts.map((_, i) => `${i + 1}=lucienne_${i + 1}`).join('\n') + '\n';
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]!);
/** Source shortcuts win. Clear each claimed key from every other captured native action. */
export function shortcutXml(calibration: KdenliveCalibration, operations: readonly Operation[]): string {
  assertCalibration(calibration);
  const bindings = nativeBindings(operations), claimed = new Set(Object.values(bindings));
  if (Object.keys(bindings).some(action => !Object.hasOwn(calibration.defaultShortcuts, action))) throw new Error('KDENLIVE_NATIVE_ACTION_MISSING');
  const actions = Object.entries(calibration.defaultShortcuts).map(([id, shortcuts]) => {
    if (!/^[A-Za-z0-9_. -]+$/.test(id) || !Array.isArray(shortcuts) || shortcuts.some(s => typeof s !== 'string' || s.length > 80)) throw new Error('KDENLIVE_INVALID_SHORTCUT_INVENTORY');
    const chosen = bindings[id] ? [bindings[id]] : shortcuts.filter(s => !claimed.has(s));
    return `<Action name="${escape(id)}" shortcut="${escape(chosen.join('; '))}"/>`;
  });
  return `<gui name="kdenlive" version="1"><ActionProperties>${actions.join('')}</ActionProperties></gui>\n`;
}
