import { z } from 'zod';

// host is the sole writer. Version 1 is shared by every product surface/provider.
const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/);
const text = z.string().min(1).max(600);
const refs = z.array(id).min(1).max(32);
export const SourceAppSchema = z.enum(['photoshop', 'illustrator', 'gimp', 'premiere', 'after-effects', 'resolve']);
export const TargetAppSchema = z.enum(['blender', 'krita', 'reaper', 'kdenlive']);
export const ModeSchema = z.enum(['live', 'prepared', 'replay', 'simulated']);
export const TargetSchema = z.strictObject({ appId: TargetAppSchema, adapterVersion: id });
export const ProvenanceSchema = z.strictObject({ mode: ModeSchema, provider: id, evidenceRefs: refs });
export const PreferenceSchema = z.strictObject({
  key: id, value: z.string().min(1).max(160), origin: z.enum(['explicit', 'inferred']), evidenceRefs: refs,
});
export const SourceProfileSchema = z.strictObject({
  version: z.literal(1), profileId: id, revision: id, sourceApp: SourceAppSchema, personaId: id,
  label: text, provenance: ProvenanceSchema, evidenceRefs: refs,
  bindings: z.record(id, z.string().min(1).max(80)), preferences: z.array(PreferenceSchema).max(32),
});
// Capability IDs and finite values are supplied by trusted adapters, never by the model.
// A key connects semantic preferences to native recipes; bindingAction connects source shortcuts.
export const CapabilitySchema = z.strictObject({
  id, kind: z.enum(['layout', 'binding', 'canvas', 'timeline', 'tool-layout']),
  values: z.array(z.string().min(1).max(160)).min(1).max(64),
  preferenceKey: id.optional(), bindingAction: id.optional(),
});
export const OperationSchema = z.strictObject({ capabilityId: id, value: z.string().min(1).max(160) });
export const ChatIntentSchema = z.enum(['move-key-panels', 'enlarge-work-area', 'simplify-tools']);
// Trusted host policy for one exact source revision/scenario/adapter. Model output and
// renderer commands cannot introduce this policy; source shortcut values remain authoritative.
export const BindingApplicabilityEntrySchema = z.discriminatedUnion('status', [
  z.strictObject({ sourceAction: id, status: z.literal('mapped'), capabilityId: id,
    relation: z.enum(['direct', 'equivalent']), limitation: text.optional(), evidenceRefs: refs }),
  z.strictObject({ sourceAction: id, status: z.literal('unavailable'), reason: z.literal('target-feature-absent'),
    limitation: text, evidenceRefs: refs }),
  z.strictObject({ sourceAction: id, status: z.literal('unchanged'), reason: z.literal('outside-selected-main-controls'),
    limitation: text, evidenceRefs: refs }),
]);
export const BindingApplicabilitySchema = z.strictObject({
  version: z.literal(1), scenarioId: id,
  source: z.strictObject({ profileId: id, revision: id, sourceApp: SourceAppSchema }),
  target: TargetSchema,
  // At most 64 managed operations and 12 individually disclosed nonmapped actions.
  entries: z.array(BindingApplicabilityEntrySchema).max(76),
});
export const PlannerRequestSchema = z.strictObject({
  version: z.literal(1), runId: id, requestId: id, scenarioId: id,
  kind: z.enum(['translate', 'chat']), target: TargetSchema, source: SourceProfileSchema,
  explicit: z.array(z.strictObject({ key: id, value: z.string().min(1).max(160) })).max(32),
  instruction: z.string().max(2000), intent: ChatIntentSchema.optional(),
  catalog: z.array(CapabilitySchema).min(1).max(64),
  // Full desired state from the previous committed patch; chat returns a complete replacement.
  currentOperations: z.array(OperationSchema).max(64), evidenceRefs: refs,
  bindingApplicability: BindingApplicabilitySchema.optional(),
});
export const NativePatchSchema = z.strictObject({
  version: z.literal(1), runId: id, requestId: id, scenarioId: id, target: TargetSchema,
  operations: z.array(OperationSchema).min(1).max(64), evidenceRefs: refs,
  summary: text, limitations: z.array(text).max(12),
});
export const PlannerResultSchema = z.strictObject({ patch: NativePatchSchema, provenance: ProvenanceSchema });
export const PhaseSchema = z.enum(['idle', 'selected', 'planning', 'applying', 'ready', 'chat', 'closing', 'resetting', 'error']);
export const EventTypeSchema = z.enum(['selected', 'planning', 'progress', 'applying', 'target-ready', 'chat-opened', 'chat-applied', 'chat-closed', 'closing', 'reset-started', 'reset-completed', 'failed']);
// Public display copy authored by the trusted host, never provider reasoning or
// arbitrary model text. Each event carries a complete bounded card snapshot.
export const RunPresentationSchema = z.strictObject({
  version: z.literal(1),
  cards: z.array(z.strictObject({ heading: z.string().min(1).max(80), body: z.string().min(1).max(240) })).max(3),
  activity: z.string().min(1).max(240),
});
export const RunEventSchema = z.strictObject({
  version: z.literal(1), eventId: id, runId: id, requestId: id.nullable(), scenarioId: id,
  sequence: z.number().int().positive(), generation: z.number().int().nonnegative(),
  at: z.string().datetime(), monotonicMs: z.number().nonnegative(),
  type: EventTypeSchema, phase: PhaseSchema, target: TargetSchema,
  mode: ModeSchema, provider: id, evidenceKind: z.enum(['native', 'fixture', 'none']),
  remainingMs: z.number().nonnegative(), code: id.optional(), evidenceRefs: z.array(id).max(32),
  presentation: RunPresentationSchema.optional(),
});
export const QAResultSchema = z.strictObject({
  version: z.literal(1), resultId: id, runId: id, scenarioId: id, target: TargetSchema,
  profileId: id, check: z.enum(['native-task', 'chat', 'reset', 'relaunch', 'layout', 'performance']),
  status: z.enum(['pass', 'fail', 'blocked', 'not-run']), evidenceKind: z.enum(['native', 'fixture', 'none']),
  measuredAt: z.string().datetime(), evidenceRefs: z.array(id).max(32),
  metrics: z.array(z.strictObject({ name: id, value: z.number().finite(), unit: z.enum(['ms', 'count', 'bytes', 'ratio']) })).max(32),
  limitations: z.array(text).max(12),
});
// profile service prepares the LLM quiz interface. This does not prescribe question count/presentation.
export const QuizTurnSchema = z.strictObject({
  version: z.literal(1), turnId: id, role: z.enum(['assistant', 'user']), text: z.string().min(1).max(2000),
});
export const QuizResultSchema = z.strictObject({
  version: z.literal(1), status: z.enum(['continue', 'complete']), question: text.optional(),
  profile: SourceProfileSchema.optional(), provenance: ProvenanceSchema,
});
export type SourceApp = z.infer<typeof SourceAppSchema>;
export type TargetApp = z.infer<typeof TargetAppSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type SourceProfile = z.infer<typeof SourceProfileSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type PlannerRequest = z.infer<typeof PlannerRequestSchema>;
export type NativePatch = z.infer<typeof NativePatchSchema>;
export type PlannerResult = z.infer<typeof PlannerResultSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunPresentation = z.infer<typeof RunPresentationSchema>;
export type QAResult = z.infer<typeof QAResultSchema>;
export type ChatIntent = z.infer<typeof ChatIntentSchema>;
export type BindingApplicability = z.infer<typeof BindingApplicabilitySchema>;
export type BindingApplicabilityEntry = z.infer<typeof BindingApplicabilityEntrySchema>;
export type BindingRequirementContext = Pick<PlannerRequest,
  'scenarioId' | 'source' | 'target' | 'catalog' | 'evidenceRefs' | 'bindingApplicability'>;
export interface BindingRequirements {
  requiredOperations: Operation[];
  limitations: string[];
}

/** Resolve host policy without changing source bindings or granting native capability/QA claims.
 * With no policy, retain the legacy requirement that every source action maps directly.
 * Policy evidence must already be trusted by the host in request.evidenceRefs; a model's
 * patch evidence or source-only references cannot authorize an exemption.
 */
export function resolveBindingRequirements(raw: BindingRequirementContext): BindingRequirements {
  const context = z.object({ scenarioId: id, source: SourceProfileSchema, target: TargetSchema,
    catalog: z.array(CapabilitySchema).min(1).max(64), evidenceRefs: refs,
    bindingApplicability: BindingApplicabilitySchema.optional() }).parse(raw);
  const { source, catalog, bindingApplicability: policy } = context;
  assertRoute(source.sourceApp, context.target.appId);
  if (new Set(catalog.map(c => c.id)).size !== catalog.length) throw new Error('DUPLICATE_KEY');
  const bindingCatalog = catalog.filter(c => c.kind === 'binding');
  if (catalog.some(c => (c.kind === 'binding') !== !!c.bindingAction)) throw new Error('INVALID_BINDING_CAPABILITY');
  if (new Set(bindingCatalog.map(c => c.bindingAction)).size !== bindingCatalog.length) throw new Error('AMBIGUOUS_CAPABILITY');
  const sourceActions = Object.keys(source.bindings).sort();
  if (!policy) {
    return { requiredOperations: sourceActions.map(sourceAction => {
      const capability = bindingCatalog.find(c => c.bindingAction === sourceAction);
      const value = source.bindings[sourceAction]!;
      if (!capability || !capability.values.includes(value)) throw new Error('SOURCE_BINDING_NOT_PRESERVED');
      return { capabilityId: capability.id, value };
    }), limitations: [] };
  }
  if (policy.scenarioId !== context.scenarioId || policy.source.profileId !== source.profileId ||
      policy.source.revision !== source.revision || policy.source.sourceApp !== source.sourceApp ||
      policy.target.appId !== context.target.appId || policy.target.adapterVersion !== context.target.adapterVersion) {
    throw new Error('BINDING_APPLICABILITY_SCOPE_MISMATCH');
  }
  const entries = new Map<string, BindingApplicabilityEntry>();
  const knownRefs = new Set(context.evidenceRefs);
  for (const entry of policy.entries) {
    if (entries.has(entry.sourceAction)) throw new Error('DUPLICATE_BINDING_APPLICABILITY');
    if (!Object.hasOwn(source.bindings, entry.sourceAction)) throw new Error('UNKNOWN_SOURCE_BINDING');
    if (new Set(entry.evidenceRefs).size !== entry.evidenceRefs.length || entry.evidenceRefs.some(ref => !knownRefs.has(ref))) {
      throw new Error('UNTRUSTED_BINDING_APPLICABILITY_EVIDENCE');
    }
    entries.set(entry.sourceAction, entry);
  }
  if (entries.size !== sourceActions.length) throw new Error('INCOMPLETE_BINDING_APPLICABILITY');
  const requiredOperations: Operation[] = [];
  const limitations: string[] = [];
  const mapped = new Set<string>();
  for (const sourceAction of sourceActions) {
    const entry = entries.get(sourceAction)!;
    if (entry.status === 'mapped') {
      const capability = bindingCatalog.find(c => c.id === entry.capabilityId);
      if (!capability) throw new Error('INVALID_MAPPED_BINDING_CAPABILITY');
      if (mapped.has(capability.id)) throw new Error('DUPLICATE_BINDING_CAPABILITY_MAPPING');
      if (entry.relation === 'direct' && capability.bindingAction !== sourceAction) throw new Error('DIRECT_BINDING_SEMANTIC_MISMATCH');
      const value = source.bindings[sourceAction]!;
      if (!capability.values.includes(value)) throw new Error('SOURCE_BINDING_NOT_SUPPORTED');
      mapped.add(capability.id);
      requiredOperations.push({ capabilityId: capability.id, value });
    } else {
      // An equivalent mapping from another source action must not silently manage a
      // control whose own source action was declared absent or unchanged.
      if (bindingCatalog.some(capability => capability.bindingAction === sourceAction)) {
        throw new Error('NONMAPPED_BINDING_STILL_MANAGED');
      }
    }
    // Trusted caveats about an equivalent or contextual mapping are as mandatory
    // as notices about omitted controls; they share one bounded disclosure budget.
    if (entry.limitation !== undefined) {
      const limitation = `${sourceAction}: ${entry.limitation}`;
      if (!entry.limitation.trim() || limitation.length > 600) throw new Error('INVALID_BINDING_LIMITATION');
      limitations.push(limitation);
    }
  }
  if (limitations.length > 12) throw new Error('TOO_MANY_BINDING_LIMITATIONS');
  if (bindingCatalog.length !== mapped.size) throw new Error('UNACCOUNTED_MANAGED_BINDING');
  return { requiredOperations, limitations };
}

export const ROUTES: Readonly<Record<SourceApp, readonly TargetApp[]>> = {
  photoshop: ['blender', 'krita', 'kdenlive'], illustrator: ['blender', 'krita', 'kdenlive'],
  gimp: ['blender', 'krita', 'kdenlive'], premiere: ['blender', 'reaper', 'kdenlive'],
  'after-effects': ['blender', 'reaper', 'kdenlive'], resolve: ['blender', 'reaper', 'kdenlive'],
};
export function assertRoute(source: SourceApp, target: TargetApp): void {
  if (!ROUTES[source].includes(target)) throw new Error('UNAPPROVED_ROUTE');
}
export function validateRequest(value: unknown): PlannerRequest {
  const request = PlannerRequestSchema.parse(value);
  assertRoute(request.source.sourceApp, request.target.appId);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(request.catalog.map(c => c.id)) || !unique(request.explicit.map(p => p.key)) ||
      !unique(request.source.preferences.map(p => p.key))) throw new Error('DUPLICATE_KEY');
  for (const kind of ['bindingAction', 'preferenceKey'] as const) {
    if (!unique(request.catalog.flatMap(c => c[kind] ? [c[kind]!] : []))) throw new Error('AMBIGUOUS_CAPABILITY');
  }
  if (request.catalog.some(c => (c.kind === 'binding') !== !!c.bindingAction)) throw new Error('INVALID_BINDING_CAPABILITY');
  if (request.kind === 'translate' && (request.intent || request.currentOperations.length)) throw new Error('INVALID_TRANSLATE_REQUEST');
  if (request.kind === 'chat' && !request.intent) throw new Error('MISSING_CHAT_INTENT');
  validateOperations(request.currentOperations, request.catalog, request.kind === 'chat');
  // Reject incomplete/unproven host policy before any planner is invoked. Legacy requests
  // retain their existing request validation and strict binding checks at patch validation.
  if (request.bindingApplicability) resolveBindingRequirements(request);
  return request;
}
function validateOperations(operations: Operation[], catalog: Capability[], complete: boolean): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const capability = catalog.find(c => c.id === operation.capabilityId);
    if (!capability || !capability.values.includes(operation.value)) throw new Error('UNSUPPORTED_OPERATION');
    if (seen.has(operation.capabilityId)) throw new Error('DUPLICATE_OPERATION');
    seen.add(operation.capabilityId);
  }
  if (complete && seen.size !== catalog.length) throw new Error('INCOMPLETE_PATCH');
}
export function validatePatch(value: unknown, rawRequest: PlannerRequest): NativePatch {
  const request = validateRequest(rawRequest);
  const patch = NativePatchSchema.parse(value);
  for (const key of ['runId', 'requestId', 'scenarioId'] as const) {
    if (patch[key] !== request[key]) throw new Error('WRONG_PATCH_IDENTITY');
  }
  if (patch.target.appId !== request.target.appId || patch.target.adapterVersion !== request.target.adapterVersion) throw new Error('WRONG_ADAPTER');
  const allowedRefs = new Set([...request.evidenceRefs, ...request.source.evidenceRefs, ...request.source.provenance.evidenceRefs,
    ...request.source.preferences.flatMap(p => p.evidenceRefs)]);
  if (patch.evidenceRefs.some(ref => !allowedRefs.has(ref))) throw new Error('UNKNOWN_EVIDENCE');
  validateOperations(patch.operations, request.catalog, true);
  if (request.kind === 'chat') {
    const current = new Map(request.currentOperations.map(op => [op.capabilityId, op.value]));
    const allowedKinds = request.intent === 'move-key-panels' ? ['layout'] :
      request.intent === 'enlarge-work-area' ? ['canvas', 'timeline'] : ['tool-layout'];
    for (const operation of patch.operations) {
      const capability = request.catalog.find(c => c.id === operation.capabilityId)!;
      if (current.get(operation.capabilityId) !== operation.value && !allowedKinds.includes(capability.kind)) throw new Error('OUT_OF_SCOPE_CHAT_CHANGE');
    }
  }
  const explicit = new Map(request.source.preferences.filter(p => p.origin === 'explicit').map(p => [p.key, p.value]));
  request.explicit.forEach(p => explicit.set(p.key, p.value));
  const applied = new Map(patch.operations.map(op => [op.capabilityId, op.value]));
  for (const [key, value] of explicit) {
    const capability = request.catalog.find(c => c.preferenceKey === key);
    if (!capability || applied.get(capability.id) !== value) throw new Error('EXPLICIT_PREFERENCE_NOT_PRESERVED');
  }
  const bindings = resolveBindingRequirements(request);
  for (const operation of bindings.requiredOperations) {
    if (applied.get(operation.capabilityId) !== operation.value) throw new Error('SOURCE_BINDING_NOT_PRESERVED');
  }
  if (bindings.limitations.some(limitation => !patch.limitations.includes(limitation))) throw new Error('BINDING_LIMITATION_REQUIRED');
  return patch;
}
