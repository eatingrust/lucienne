import type { Capability, Operation } from '../../contracts/index.js';
export interface AXNode {
  id: number; role?: string; title?: string; description?: string; identifier?: string;
  enabled?: boolean; modal?: boolean; minimized?: boolean; value?: unknown; menuMarkCharacter?: string;
  position?: {x: number; y: number}; size?: {width: number; height: number};
  menuCommandCharacter?: string; menuCommandModifiers?: number; menuCommandVirtualKey?: number;
}
export interface NativeSnapshot {
  version: 1; ok: true; observedAt: string; pid: number; uid: number; consoleUid: number;
  bundleId: string; executable: string; truncated: boolean;
  app: { active: boolean; hidden: boolean; terminated: boolean };
  roots: {windows: number[]}; nodes: AXNode[];
  windowServer: {onScreen?: boolean; layer?: number; alpha?: number}[];
}
export interface Selector { role: string; title?: string; description?: string; identifier?: string }
export interface GeometryRule {
  capabilityId: string; value: string; selector: Selector;
  /** Compare an actual native element rectangle with the actual main window. */
  axis: 'center-x' | 'height-ratio' | 'width-ratio'; min: number; max: number;
}
export interface ToggleRule { capabilityId: string; value: string; selector: Selector; checked: boolean }
export interface BindingObservation { capabilityId: string; menuTitle: string }
export interface ObservationRules {
  geometry: GeometryRule[]; toggles: ToggleRule[]; bindings: BindingObservation[];
  interactiveControls: Selector[];
}
function select(nodes: AXNode[], selector: Selector): AXNode | undefined {
  const matches = nodes.filter(node => node.role === selector.role &&
    (selector.title === undefined || node.title === selector.title) &&
    (selector.description === undefined || node.description === selector.description) &&
    (selector.identifier === undefined || node.identifier === selector.identifier));
  return matches.length === 1 ? matches[0] : undefined;
}
function checked(node: AXNode): boolean | undefined {
  if (typeof node.value === 'boolean') return node.value;
  if (typeof node.value === 'number' && [0, 1].includes(node.value)) return node.value === 1;
  if (typeof node.menuMarkCharacter === 'string') return node.menuMarkCharacter !== '';
  return undefined;
}
export function observeOperations(snapshot: NativeSnapshot, rules: ObservationRules, catalog: readonly Capability[]): {
  targetVisible: boolean; interactive: boolean; operations: Operation[];
} {
  if (snapshot.version !== 1 || snapshot.ok !== true || snapshot.uid !== 502 || snapshot.consoleUid !== 502 ||
      snapshot.bundleId !== 'org.kde.Kdenlive' || snapshot.executable !== '/PUBLIC_NATIVE_APPS_REQUIRED/kdenlive.app/Contents/MacOS/kdenlive' ||
      !Array.isArray(snapshot.nodes) || snapshot.truncated !== false || !snapshot.app ||
      typeof snapshot.app.active !== 'boolean' || typeof snapshot.app.hidden !== 'boolean' || typeof snapshot.app.terminated !== 'boolean')
    throw new Error('KDENLIVE_INCOMPLETE_OBSERVATION');
  const validRect = (n: AXNode) => !!n.size && !!n.position && [n.size.width,n.size.height,n.position.x,n.position.y].every(Number.isFinite) && n.size.width > 0 && n.size.height > 0;
  const windows = snapshot.nodes.filter(n => snapshot.roots.windows.includes(n.id) && n.role === 'AXWindow' && n.modal === false && n.minimized === false && validRect(n));
  const window = windows.length === 1 && snapshot.roots.windows.length === 1 ? windows[0] : undefined;
  const targetVisible = !!window && !snapshot.app.hidden && !snapshot.app.terminated &&
    snapshot.windowServer.some(w => w.onScreen === true && w.layer === 0 && (w.alpha ?? 0) > 0);
  const interactive = targetVisible && snapshot.app.active && !snapshot.nodes.some(n => n.modal === true || n.role === 'AXSheet') &&
    rules.interactiveControls.length >= 2 && rules.interactiveControls.every(rule => select(snapshot.nodes, rule)?.enabled === true);
  const observations: Operation[] = [];
  if (!window) return {targetVisible, interactive, operations: observations};
  for (const rule of rules.geometry) {
    const node = select(snapshot.nodes, rule.selector);
    if (!node || !validRect(node)) continue;
    const value = rule.axis === 'center-x' ? (node.position!.x + node.size!.width / 2 - window.position!.x) / window.size!.width :
      rule.axis === 'height-ratio' ? node.size!.height / window.size!.height : node.size!.width / window.size!.width;
    if (Number.isFinite(value) && value >= rule.min && value <= rule.max) observations.push({capabilityId: rule.capabilityId, value: rule.value});
  }
  for (const rule of rules.toggles) {
    const node = select(snapshot.nodes, rule.selector);
    if (node && checked(node) === rule.checked) observations.push({capabilityId: rule.capabilityId, value: rule.value});
  }
  for (const rule of rules.bindings) {
    const node = select(snapshot.nodes, {role: 'AXMenuItem', title: rule.menuTitle});
    if (!node || node.menuCommandModifiers !== 8) continue; // 8 = no Command modifier on macOS.
    const character = node.menuCommandCharacter;
    const value = character === ' ' || (character === '' && node.menuCommandVirtualKey === 49) ? 'Space' : character?.toUpperCase();
    if (value) observations.push({capabilityId: rule.capabilityId, value});
  }
  // Ambiguous or unobserved values are omitted, never filled from the desired patch.
  return {targetVisible, interactive, operations: catalog.flatMap(cap => {
    const found = observations.filter(o => o.capabilityId === cap.id && cap.values.includes(o.value));
    const values = [...new Set(found.map(o => o.value))];
    return values.length === 1 ? [{capabilityId: cap.id, value: values[0]}] : [];
  })};
}
