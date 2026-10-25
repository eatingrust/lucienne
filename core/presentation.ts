import type {
  Capability, Operation, PlannerRequest, RunEvent, RunPresentation, SourceApp, SourceProfile, TargetApp,
} from '../contracts/index.js';

const sources: Record<SourceApp, string> = {
  photoshop: 'Photoshop', illustrator: 'Illustrator', gimp: 'GIMP', premiere: 'Premiere',
  'after-effects': 'After Effects', resolve: 'DaVinci Resolve',
};
const targets: Record<TargetApp, string> = { blender: 'Blender', krita: 'Krita', reaper: 'REAPER', kdenlive: 'Kdenlive' };
const layout = [
  { key: 'panel-side', label: 'Panel placement', values: { left: 'Panels on the left', right: 'Panels on the right' } },
  { key: 'work-area', label: 'Work area', values: { normal: 'Standard work area', large: 'Larger work area' } },
  { key: 'tool-density', label: 'Tool density', values: { full: 'Full controls', simple: 'Simplified controls' } },
] as const;

export interface PresentationContext {
  type: RunEvent['type'];
  source: SourceProfile;
  target: TargetApp;
  mode: RunEvent['mode'];
  evidenceKind: RunEvent['evidenceKind'];
  catalog: readonly Capability[];
  explicit: PlannerRequest['explicit'];
  /** Only supply a validated plan or the last readback-verified operations. */
  operations: readonly Operation[];
}

/** A deliberately finite vocabulary: IDs, labels, instructions, summaries,
 * evidence paths, provider output and arbitrary values never become display text.
 * Calling this does not emit events or retain a visitor's presentation. */
export function publicRunPresentation(context: PresentationContext): RunPresentation | undefined {
  const { type } = context;
  if (type === 'reset-started' || type === 'reset-completed') return undefined;
  const fixture = context.evidenceKind === 'fixture';
  const activity = (text: string) => fixture ? `Preview: ${text}` : text;
  if (type === 'failed') return { version: 1, cards: [], activity: activity('The current action failed; success has not been confirmed.') };
  if (type === 'closing') return { version: 1, cards: [], activity: activity('Exploration has finished; reset is next.') };

  const preferences = new Map(context.source.preferences.map(value => [value.key, value]));
  const explicit = new Map(context.explicit.map(value => [value.key, value.value]));
  const knownLayout = (operations: readonly Operation[] | undefined) => layout.flatMap(entry => {
    const capability = context.catalog.find(value => value.preferenceKey === entry.key);
    const value = operations
      ? operations.find(value => value.capabilityId === capability?.id)?.value
      : explicit.get(entry.key) ?? preferences.get(entry.key)?.value;
    if (!capability || value === undefined || !capability.values.includes(value) || !Object.hasOwn(entry.values, value)) return [];
    const phrase = (entry.values as Readonly<Record<string, string>>)[value]!;
    const preference = preferences.get(entry.key);
    const reason = explicit.get(entry.key) === value || (preference?.value === value && preference.origin === 'explicit')
      ? `${entry.label} follows an explicit preference.`
      : preference?.value === value
        ? `${entry.label} follows the selected profile.`
        : `${entry.label} is a validated supported choice.`;
    return [{ phrase, reason }];
  });

  if (type === 'selected' || type === 'planning' || type === 'progress') {
    const requested = knownLayout(undefined);
    return { version: 1, cards: [
      { heading: 'Workflow', body: `Preparing ${targets[context.target]} from familiar ${sources[context.source.sourceApp]} controls.` },
      { heading: 'Requested layout', body: requested.length ? `${requested.map(value => value.phrase).join('; ')}.`
        : 'Supported layout choices will be checked before any changes are applied.' },
    ], activity: activity(type === 'selected' ? 'Workflow selected.'
      : context.mode === 'prepared' ? 'Checking the prepared workspace plan.'
      : type === 'progress' ? 'The planner is working on the workspace.' : 'Planning the workspace.') };
  }

  // Applying receives the newly validated plan; the remaining events use only
  // operations retained after matching native readback. Neither uses patch.summary.
  const planned = type === 'applying';
  const choices = knownLayout(context.operations);
  const mapped = context.catalog.filter(capability => capability.kind === 'binding'
    && context.operations.some(operation => operation.capabilityId === capability.id && capability.values.includes(operation.value))).length;
  const controls = `${context.operations.length} supported control${context.operations.length === 1 ? '' : 's'}`;
  const past = context.operations.length === 1 ? 'was' : 'were';
  const shortcuts = `${mapped} supported shortcut mapping${mapped === 1 ? '' : 's'}`;
  const cards: RunPresentation['cards'] = [
    { heading: planned ? 'Layout plan' : fixture ? 'Preview layout' : 'Verified layout',
      body: choices.length ? `${choices.map(value => value.phrase).join('; ')}.`
        : `${controls} ${planned ? `${context.operations.length === 1 ? 'is' : 'are'} included in the plan` : fixture ? `${past} checked in this preview` : `${past} verified by readback`}.` },
  ];
  if (choices.length) cards.push({ heading: 'Why these choices', body: choices.map(value => value.reason).join(' ') });
  if (mapped) cards.push({ heading: 'Familiar shortcuts', body: planned
    ? `The validated plan includes ${shortcuts}.`
    : `${shortcuts} ${mapped === 1 ? 'was' : 'were'} ${fixture ? 'checked in this preview' : 'verified in the target'}.` });
  const activities: Partial<Record<RunEvent['type'], string>> = {
    applying: 'Applying the validated workspace plan.',
    'target-ready': `${targets[context.target]} is ready; its controls match the plan.`,
    'chat-opened': 'Chat opened; exploration is paused.',
    'chat-applied': 'The requested adjustment is verified; exploration has resumed.',
    'chat-closed': 'Exploration resumed with the current workspace.',
  };
  return { version: 1, cards, activity: activity(activities[type] ?? 'Workspace status updated.') };
}
