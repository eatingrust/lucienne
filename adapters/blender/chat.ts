import type { ChatIntent, Operation } from '../../contracts/index.js';
/** Concrete target prompts; the provider still plans each live replacement patch. */
export const BLENDER_CHAT_PROMPTS: Readonly<Record<ChatIntent, string>> = Object.freeze({
  'move-key-panels': 'Move the 3D tool sidebar to the other side.',
  'enlarge-work-area': 'Give the 3D viewport more room by hiding its sidebar and tool header.',
  'simplify-tools': 'Hide the full toolbar so I can focus on selecting and moving objects.',
});
/** Explicit user button action overrides the prior panel preference; source bindings remain intact. */
export function blenderChatExplicit(intent: ChatIntent, current: readonly Operation[]): Array<{ key: string; value: string }> {
  const value = (id: string, choices: readonly string[]) => {
    const matches = current.filter(op => op.capabilityId === id);
    if (matches.length !== 1 || !choices.includes(matches[0].value)) throw new Error('BLENDER_CHAT_STATE_REQUIRED');
    return matches[0].value;
  };
  if (intent === 'move-key-panels') return [{ key: 'panel-side',
    value: value('blender.layout.panel-side', ['left', 'right']) === 'left' ? 'right' : 'left' }];
  if (intent === 'enlarge-work-area') return [{ key: 'work-area', value: 'large' }];
  if (intent === 'simplify-tools') return [{ key: 'tool-density', value: 'simple' }];
  throw new Error('BLENDER_CHAT_INTENT_UNSUPPORTED');
}
