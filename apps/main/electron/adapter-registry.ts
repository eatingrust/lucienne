import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { accessSync, constants, lstatSync } from 'node:fs';
import { z } from 'zod';
import { ChatIntentSchema, SourceProfileSchema, resolveBindingRequirements, validatePatch, validateRequest,
  type Capability, type ChatIntent, type Operation, type PlannerRequest, type SourceApp,
  type SourceProfile, type Target, type TargetApp } from '../../../contracts/index.js';
import type { NativeAdapter } from '../../../contracts/ports.js';
import type { Selection } from '../../../core/session.js';
import type { RuntimeScenario } from '../../../contracts/bridge.js';
import { loadProfiles, plannedCases, preparationGaps } from '../../../profiles/index.js';
import { sourceThumbnailForProfile } from '../../../profiles/source-thumbnails.js';
import { matrix, type PersonaRoster } from '../../../qa/matrix.js';
import { KRITA_CATALOG, KRITA_TARGET, resolveKritaRecipe } from '../../../adapters/krita/catalog.js';
import type { KritaAdapterOptions } from '../../../adapters/krita/index.js';
import { BLENDER_CATALOG, BLENDER_TARGET, resolveBlenderRecipe, createBlenderBindingSetup } from '../../../adapters/blender/catalog.js';
import { BLENDER_CHAT_PROMPTS, blenderChatExplicit } from '../../../adapters/blender/chat.js';
import type { BlenderAdapterOptions } from '../../../adapters/blender/index.js';
import { REAPER_TARGET, catalogForSource, resolveReaperRecipe, createReaperBindingSetup } from '../../../adapters/reaper/catalog.js';
import { REAPER_CHAT_PROMPTS } from '../../../adapters/reaper/example.js';
import type { ReaperAdapterOptions } from '../../../adapters/reaper/index.js';
import { KDENLIVE_TARGET, kdenliveCatalog } from '../../../adapters/kdenlive/catalog.js';

const absolutePath = z.string().min(1).refine(value => path.isAbsolute(value) &&
  path.resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value));
const ConfigSchema = z.strictObject({
  buildId: z.string().regex(/^[a-zA-Z0-9._:/-]{1,160}$/), evidenceRoot: absolutePath,
  assets: z.strictObject({
    krita: z.strictObject({ pluginDirectory: absolutePath }).optional(),
    blender: z.strictObject({ nativeDirectory: absolutePath, windowProbePath: absolutePath }).optional(),
    reaper: z.strictObject({ nativeDirectory: absolutePath, probeExecutable: absolutePath }).optional(),
  }),
});
/** Main-process configuration only. No paths, catalogs, profiles or constructors belong in IPC. */
export type NativeRegistryConfig = z.infer<typeof ConfigSchema>;
export interface NativeRegistryAdapter extends NativeAdapter { preflight?: () => Promise<unknown> }
/** Host-only seam. Main injects constructors from its trusted packaged ESM modules. */
export interface NativeAdapterConstructors {
  krita(options: KritaAdapterOptions): NativeRegistryAdapter;
  blender(options: BlenderAdapterOptions): NativeRegistryAdapter;
  reaper(options: ReaperAdapterOptions): NativeRegistryAdapter;
}
export interface NativeChatIntent { readonly intent: ChatIntent; readonly label: string; readonly instruction: string }
export interface NativeScenarioRow extends RuntimeScenario {}
type Recipe = { operations: Operation[]; evidenceRefs: string[]; limitations?: string[] };
export interface RegisteredNativeScenario {
  readonly row: NativeScenarioRow; readonly selection: Selection; readonly adapter: NativeRegistryAdapter;
  resolvePreparedRecipe(request: PlannerRequest): Recipe;
  chat(intent: ChatIntent, currentOperations?: readonly Operation[]): {
    intent: ChatIntent; instruction: string; explicit: PlannerRequest['explicit'];
  };
}
export interface NativeAdapterRegistry {
  list(): readonly NativeScenarioRow[];
  create(scenarioId: string): RegisteredNativeScenario;
}
/** Fences asynchronous account/preflight checks against reset and concurrent selection. */
export class ScenarioSelectionGate {
  private generation = 0;
  private selecting = false;
  invalidate(): void { this.generation++; }
  async run<T>(options: { isIdle(): boolean; guard(): Promise<void>;
    prepare(assertCurrent: () => void): Promise<T>; commit(value: T): void }): Promise<void> {
    if (this.selecting || !options.isIdle()) return fail('RESET_REQUIRED');
    this.selecting = true;
    const generation = ++this.generation;
    const assertCurrent = () => {
      if (generation !== this.generation || !options.isIdle()) return fail('SCENARIO_SELECTION_CANCELLED');
    };
    try {
      await options.guard(); assertCurrent();
      const value = await options.prepare(assertCurrent); assertCurrent();
      options.commit(value);
    } finally { this.selecting = false; }
  }
}
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const kritaChat: readonly NativeChatIntent[] = freeze([
  { intent: 'move-key-panels', label: 'Move Layers to the right', instruction: 'Move Layers to the right.' },
  { intent: 'enlarge-work-area', label: 'Enlarge the canvas', instruction: 'Give the canvas more room.' },
  { intent: 'simplify-tools', label: 'Simplify controls', instruction: 'Simplify the visible controls for this task.' },
]);
const blenderChat: readonly NativeChatIntent[] = freeze(kritaChat.map(({ intent }) => ({
  intent, label: intent === 'move-key-panels' ? 'Move the 3D sidebar' :
    intent === 'enlarge-work-area' ? 'Enlarge the viewport' : 'Hide the full toolbar',
  instruction: BLENDER_CHAT_PROMPTS[intent],
})));
const chats: Readonly<Record<TargetApp, readonly NativeChatIntent[]>> = freeze({
  krita: kritaChat, blender: blenderChat, reaper: structuredClone(REAPER_CHAT_PROMPTS), kdenlive: [],
});
const targets: Readonly<Record<TargetApp, Target>> = {
  krita: KRITA_TARGET, blender: BLENDER_TARGET, reaper: REAPER_TARGET, kdenlive: KDENLIVE_TARGET,
};
const recipes = { krita: resolveKritaRecipe, blender: resolveBlenderRecipe, reaper: resolveReaperRecipe };
function catalog(target: TargetApp, source: SourceApp): readonly Capability[] {
  return target === 'krita' ? KRITA_CATALOG : target === 'blender' ? BLENDER_CATALOG :
    target === 'reaper' ? catalogForSource(source) : kdenliveCatalog(source);
}
function requiredAssets(target: Exclude<TargetApp, 'kdenlive'>, assets: NativeRegistryConfig['assets']): Array<[string, number]> | null {
  if (target === 'krita') {
    const config = assets.krita;
    return config ? ['lucienne_bridge.desktop', 'lucienne_bridge/__init__.py', 'lucienne_bridge/bridge.py', 'lucienne_bridge/protocol.py']
      .map(file => [path.join(config.pluginDirectory, file), constants.R_OK]) : null;
  }
  if (target === 'blender') {
    const config = assets.blender;
    return config ? [
      ...['bootstrap.py', 'bridge.py', 'protocol.py', '../catalog.json'].map(file =>
        [path.join(config.nativeDirectory, file), constants.R_OK] as [string, number]),
      [config.windowProbePath, constants.R_OK | constants.X_OK],
    ] : null;
  }
  const config = assets.reaper;
  return config ? [
    ...['bridge.lua', 'bridge_core.lua', 'protocol.lua', 'actions.lua'].map(file =>
      [path.join(config.nativeDirectory, file), constants.R_OK] as [string, number]),
    [config.probeExecutable, constants.R_OK | constants.X_OK],
  ] : null;
}
function assetsAvailable(files: Array<[string, number]>): boolean {
  try {
    for (const [file, mode] of files) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      accessSync(file, mode);
    }
    return true;
  } catch { return false; }
}
function requestFor(selection: Selection, capabilities: readonly Capability[]): PlannerRequest {
  return validateRequest({ version: 1, runId: 'registry-validation', requestId: 'registry-validation',
    scenarioId: selection.scenarioId, kind: 'translate', source: selection.source, target: selection.target,
    explicit: [], instruction: '', catalog: structuredClone([...capabilities]), currentOperations: [],
    evidenceRefs: selection.evidenceRefs ?? selection.source.evidenceRefs,
    ...(selection.bindingApplicability ? { bindingApplicability: selection.bindingApplicability } : {}) });
}

/** Lists all approved cases without launching helpers/apps or reading credentials.
 * Availability is a configuration gate, never native readiness or QA evidence.
 */
export function createNativeAdapterRegistry(raw: NativeRegistryConfig,
  overrides: Partial<NativeAdapterConstructors> = {}, acceptedQuizProfiles: readonly SourceProfile[] = []): NativeAdapterRegistry {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return fail('NATIVE_REGISTRY_CONFIG_INVALID');
  const config = freeze(parsed.data);
  // Main injects constructors loaded from the packaged ESM adapter modules. Keeping
  // this metadata module free of native runtimes preserves their import.meta paths.
  const unavailable = (): never => fail('NATIVE_CONSTRUCTOR_NOT_CONFIGURED');
  const constructors: NativeAdapterConstructors = { krita: unavailable, blender: unavailable, reaper: unavailable, ...overrides };
  const profiles = new Map(loadProfiles().map(source => [source.profileId, freeze(source)]));
  // This parameter is trusted main-process state produced by QuizRuntime.accept,
  // never renderer/model input. Rebuilding rebinds each policy to the accepted
  // revision and allows full reset to discard every visitor override at once.
  const acceptedIds = new Set<string>();
  for (const rawProfile of acceptedQuizProfiles) {
    const parsedProfile = SourceProfileSchema.safeParse(rawProfile);
    if (!parsedProfile.success) return fail('NATIVE_PROFILE_OVERRIDE_INVALID');
    const candidate = parsedProfile.data, original = profiles.get(candidate.profileId);
    const identity = ({ revision: _revision, preferences: _preferences, evidenceRefs: _evidence, ...rest }: SourceProfile) => rest;
    if (!original || acceptedIds.has(candidate.profileId) || candidate.revision === original.revision ||
        !isDeepStrictEqual(identity(candidate), identity(original)) ||
        original.evidenceRefs.some(ref => !candidate.evidenceRefs.includes(ref)) ||
        new Set(candidate.evidenceRefs).size !== candidate.evidenceRefs.length ||
        new Set(candidate.preferences.map(pref => pref.key)).size !== candidate.preferences.length)
      return fail('NATIVE_PROFILE_OVERRIDE_INVALID');
    for (const previous of original.preferences.filter(pref => pref.origin === 'explicit')) {
      if (!isDeepStrictEqual(candidate.preferences.find(pref => pref.key === previous.key), previous))
        return fail('NATIVE_PROFILE_OVERRIDE_INVALID');
    }
    for (const preference of candidate.preferences) {
      if (isDeepStrictEqual(preference, original.preferences.find(pref => pref.key === preference.key))) continue;
      if (preference.origin !== 'inferred' || preference.evidenceRefs.some(ref => !candidate.evidenceRefs.includes(ref)) ||
          !preference.evidenceRefs.some(ref => ref.startsWith('quiz:invocation:')) ||
          !preference.evidenceRefs.some(ref => ref.startsWith('quiz:user:')))
        return fail('NATIVE_PROFILE_OVERRIDE_INVALID');
    }
    acceptedIds.add(candidate.profileId); profiles.set(candidate.profileId, freeze(candidate));
  }
  const roster: PersonaRoster = { photoshop: [], illustrator: [], gimp: [], premiere: [], 'after-effects': [], resolve: [] };
  for (const source of profiles.values()) roster[source.sourceApp] = [...roster[source.sourceApp], source.personaId];
  const qaCases = matrix(roster);
  const selections = new Map<string, Selection>();
  const rows: NativeScenarioRow[] = plannedCases().map(planned => {
    const source = profiles.get(planned.profileId)!;
    const target = planned.targetApp;
    const qaCase = qaCases.find(item => item.source === source.sourceApp && item.target === target && item.personaId === source.personaId);
    if (!qaCase) return fail('NATIVE_REGISTRY_SCOPE_MISMATCH');
    const binding = target === 'blender' ? createBlenderBindingSetup({ scenarioId: planned.scenarioId, source }) :
      target === 'reaper' ? createReaperBindingSetup({ scenarioId: planned.scenarioId, source }) : undefined;
    const capabilities = binding?.catalog ?? catalog(target, source.sourceApp);
    const selection: Selection = freeze({ scenarioId: planned.scenarioId, source: structuredClone(source),
      target: structuredClone(targets[target]), evidenceRefs: [...new Set([...source.evidenceRefs, ...(binding?.evidenceRefs ?? [])])],
      ...(binding ? { bindingApplicability: binding.bindingApplicability } : {}) });
    selections.set(planned.scenarioId, selection);
    let reasonCode: string | null = null, reason: string | null = null;
    if (target === 'kdenlive') {
      reasonCode = 'KDENLIVE_CALIBRATION_REQUIRED';
      reason = 'Real Kdenlive layout, shortcut and accessibility calibration is required; no calibration artifact is configured.';
    } else {
      const gaps = preparationGaps(source, target, capabilities);
      if (gaps.length) {
        reasonCode = 'SOURCE_BINDINGS_UNSUPPORTED'; reason = gaps.join('; ');
      } else {
        try {
          const request = requestFor(selection, capabilities);
          const recipe: Recipe = recipes[target](request);
          validatePatch({ version: 1, runId: request.runId, requestId: request.requestId,
            scenarioId: request.scenarioId, target: request.target, ...recipe,
            summary: 'Prepared configuration validation; no native application was run.',
            limitations: [...new Set([...(recipe.limitations ?? []), ...resolveBindingRequirements(request).limitations])] }, request);
        } catch {
          reasonCode = 'NATIVE_CONFIGURATION_UNSUPPORTED'; reason = 'The adapter has no valid complete configuration for this source profile.';
        }
      }
      if (!reasonCode) {
        const files = requiredAssets(target, config.assets);
        if (!files) {
          reasonCode = 'NATIVE_ASSETS_NOT_CONFIGURED'; reason = 'The native adapter resources have not been configured in this build.';
        } else if (!assetsAvailable(files)) {
          reasonCode = 'NATIVE_ASSETS_UNAVAILABLE'; reason = 'Required native adapter resources are missing or unreadable.';
        }
      }
    }
    return { scenarioId: planned.scenarioId, qaCaseId: qaCase.caseId, profileId: source.profileId,
      personaId: source.personaId, label: source.label, sourceApp: source.sourceApp, targetApp: target,
      source: structuredClone(source), target: structuredClone(targets[target]), catalog: structuredClone([...capabilities]),
      ...(binding ? { bindingApplicability: structuredClone(binding.bindingApplicability) } : {}),
      trustedEvidenceRefs: [...selection.evidenceRefs!], sourceThumbnail: sourceThumbnailForProfile(source.profileId, source.revision),
      selectable: reasonCode === null, reasonCode, reason,
      initialModes: reasonCode === null ? ['live', 'prepared'] : [],
      chatIntents: chats[target], nativeStatus: 'not-run' };
  });
  if (rows.length !== 54 || new Set(rows.map(row => row.scenarioId)).size !== 54) return fail('NATIVE_REGISTRY_SCOPE_MISMATCH');
  freeze(rows);
  const byId = new Map(rows.map(row => [row.scenarioId, row]));
  return Object.freeze({
    list: () => rows,
    create(scenarioId: string): RegisteredNativeScenario {
      if (typeof scenarioId !== 'string' || !byId.has(scenarioId)) return fail('UNKNOWN_NATIVE_SCENARIO');
      const row = byId.get(scenarioId)!;
      if (!row.selectable || row.targetApp === 'kdenlive') return fail('NATIVE_SCENARIO_UNAVAILABLE');
      const target = row.targetApp;
      const files = requiredAssets(target, config.assets)!;
      if (!assetsAvailable(files)) return fail('NATIVE_ASSETS_UNAVAILABLE');
      const selection = structuredClone(selections.get(scenarioId)!);
      let adapter: NativeRegistryAdapter;
      try {
        const common = { buildId: config.buildId, evidenceDirectory: config.evidenceRoot };
        if (target === 'krita') adapter = constructors.krita({ ...common, ...config.assets.krita! });
        else if (target === 'blender') adapter = constructors.blender({ ...common, ...config.assets.blender!,
          bindingContext: { scenarioId, source: structuredClone(selection.source) } });
        else {
          const source = selection.source.sourceApp;
          if (source !== 'premiere' && source !== 'after-effects' && source !== 'resolve') return fail('NATIVE_SCENARIO_UNAVAILABLE');
          adapter = constructors.reaper({ ...common, ...config.assets.reaper!, source });
        }
      } catch { return fail('NATIVE_ADAPTER_CONSTRUCTION_FAILED'); }
      // A faulty constructor must not replace the selected finite target/catalog.
      try {
        const expected = requestFor(selection, row.catalog);
        const actual = requestFor(selection, adapter.catalog);
        if (adapter.evidenceKind !== 'native' || adapter.target.appId !== selection.target.appId ||
          adapter.target.adapterVersion !== selection.target.adapterVersion ||
          JSON.stringify(actual.catalog) !== JSON.stringify(expected.catalog)) return fail('NATIVE_ADAPTER_MISMATCH');
      } catch { return fail('NATIVE_ADAPTER_MISMATCH'); }
      return Object.freeze({ row, selection: freeze(selection), adapter,
        resolvePreparedRecipe(request: PlannerRequest): Recipe {
          if (request.scenarioId !== scenarioId || !isDeepStrictEqual(request.source, selection.source) ||
            !isDeepStrictEqual(request.bindingApplicability, selection.bindingApplicability))
            return fail('NATIVE_SCENARIO_REQUEST_MISMATCH');
          return recipes[target](request);
        },
        chat(rawIntent: ChatIntent, currentOperations: readonly Operation[] = []) {
          const parsedIntent = ChatIntentSchema.safeParse(rawIntent);
          if (!parsedIntent.success) return fail('NATIVE_CHAT_INTENT_UNSUPPORTED');
          const intent = parsedIntent.data;
          const prompt = chats[target].find(item => item.intent === intent)!;
          let explicit: PlannerRequest['explicit'];
          if (target === 'blender') explicit = blenderChatExplicit(intent, currentOperations);
          else if (target === 'reaper' && intent === 'move-key-panels') {
            const panels = currentOperations.filter(operation => operation.capabilityId === 'reaper.layout.panel-side');
            if (panels.length !== 1 || !['left', 'right'].includes(panels[0]!.value)) return fail('NATIVE_CHAT_STATE_REQUIRED');
            explicit = [{ key: 'panel-side', value: panels[0]!.value === 'left' ? 'right' : 'left' }];
          } else explicit = [intent === 'move-key-panels' ? { key: 'panel-side', value: 'right' } :
            intent === 'enlarge-work-area' ? { key: 'work-area', value: 'large' } : { key: 'tool-density', value: 'simple' }];
          return { intent, instruction: prompt.instruction, explicit };
        },
      });
    },
  });
}
