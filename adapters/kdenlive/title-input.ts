import type { SourceProfile } from '../../contracts/index.js';
import type { CommitContext } from '../../contracts/ports.js';
import { randomUUID } from 'node:crypto';

/** Host-only routing kernel. It installs no keyboard listener and performs no OS
 * input. Not registered in the catalog until a calibrated native transport and
 * independent action readback exist. See native/title-input.md. */
export type TitleModifier = 'Meta' | 'Control' | 'Alt' | 'Shift';
export type TitleMode = 'selection' | 'transform' | 'pan' | 'zoom';
export interface TitleOwner {
  pid: number; processStart: string; titleWindow: string; document: string; calibrationId: string;
}
export interface TitleScope extends TitleOwner {
  /** Native monotonic clock in the same domain as handle/settle. */
  observedAt: number;
  uid: number; effectiveUid: number; consoleUid: number;
  canonicalExecutable: boolean; active: boolean; visible: boolean; complete: boolean;
  /** The title dialog itself is modal. Only additional/nested dialogs block. */
  titleDialogConfirmed: boolean; nestedModal: boolean;
  focus: 'canvas' | 'transform-controls' | 'text' | 'other' | 'unknown';
  /** Must positively observe scene text editing; AX canvas focus is insufficient. */
  textEditing: boolean | 'unknown';
  focusEpoch: string;
  canvas: {x: number; y: number; width: number; height: number};
  selectedObject?: string;
  /** Actual physical button state after this event, excluding injected input. */
  physicalButtons: readonly ('left' | 'middle' | 'right')[] | 'unknown';
}
interface EventBase { id: number; injected: boolean; modifiers: readonly TitleModifier[] }
export type TitleInputEvent = EventBase & (
  {kind: 'key'; phase: 'down' | 'up'; key: string; repeat: boolean} |
  {kind: 'pointer'; phase: 'down' | 'drag' | 'up'; button: 'left' | 'middle' | 'right'; x: number; y: number}
);
export interface TitleGuard extends TitleOwner {
  routerId: string;
  runId: string; requestId: string; generation: number; focusEpoch: string;
  eventId: number; expiresAt: number;
  canvas: TitleScope['canvas']; physicalButtons: readonly ('left' | 'middle' | 'right')[];
}
export type TitleCommand = {id: string; guard: TitleGuard} & (
  {kind: 'activate-object-selection'} |
  // This exposes native scale/rotation, not Photoshop/GIMP unified transform.
  {kind: 'focus-object-transform'; selectedObject: string} |
  {kind: 'middle-pointer'; phase: 'down' | 'drag' | 'up'; x: number; y: number} |
  {kind: 'step-viewport-zoom'; direction: 1 | -1}
);
export interface TitleDecision {
  disposition: 'pass' | 'consume' | 'replace';
  mode: TitleMode;
  command?: TitleCommand;
  requireTargetDrain: boolean;
}
const actions = ['select', 'select-rectangle', 'transform', 'pan', 'zoom'] as const;
const modifiers: TitleModifier[] = ['Meta', 'Control', 'Alt', 'Shift'];
const chord = (key: string, mods: readonly TitleModifier[]) => [...modifiers.filter(m => mods.includes(m)), key].join('+');
function validModifiers(mods: readonly TitleModifier[]): boolean {
  return Array.isArray(mods) && new Set(mods).size === mods.length && mods.every(m => modifiers.includes(m));
}
function ownerMatches(a: TitleOwner, b: TitleOwner): boolean {
  return a.pid === b.pid && a.processStart === b.processStart && a.titleWindow === b.titleWindow && a.document === b.document && a.calibrationId === b.calibrationId;
}

/** One kernel per owned title-dialog lifetime. Scope and events must come from
 * the trusted native host, never renderer/provider messages. The transport must
 * recheck each guard immediately before dispatch and settle synchronously before
 * delivering another input event. No successful receipt is task/readback proof. */
export class TitleInputRouter {
  private readonly context: CommitContext;
  private readonly owner: TitleOwner;
  private readonly bindings = new Map<string, typeof actions[number]>();
  private mode: TitleMode = 'selection';
  private modeEpoch?: string;
  private readonly consumedKeys = new Set<string>();
  private gesture?: 'pan' | 'zoom';
  private capturedLeft = false;
  private gestureCanvas?: TitleScope['canvas'];
  private pending?: {command: TitleCommand; nextMode: TitleMode};
  private lastEvent = -1;
  private nextCommand = 0;
  private readonly routerId = randomUUID();
  private lastTime = -Infinity;
  private revoked = false;
  private drainRequired = false;
  private readonly onAbort = () => { this.cancel(); };
  constructor(source: SourceProfile, context: CommitContext, owner: TitleOwner) {
    this.context = {...context}; this.owner = structuredClone(owner);
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1 || [owner.processStart, owner.titleWindow, owner.document, owner.calibrationId, context.runId, context.requestId].some(v => typeof v !== 'string' || !v || v.length > 512) ||
        !Number.isSafeInteger(context.generation) || context.generation < 0) throw new Error('KDENLIVE_TITLE_INVALID_IDENTITY');
    for (const action of actions) {
      const value = source.bindings[action];
      if (value === undefined) continue;
      const parts = value.split('+'), key = parts.pop()!, mods = parts as TitleModifier[];
      if (!/^[A-Z]$/.test(key) || !validModifiers(mods)) throw new Error('KDENLIVE_TITLE_UNSUPPORTED_SOURCE_CHORD');
      const canonical = chord(key, mods);
      if (this.bindings.has(canonical)) throw new Error('KDENLIVE_TITLE_SOURCE_COLLISION');
      this.bindings.set(canonical, action);
    }
    context.signal.addEventListener('abort', this.onAbort, {once: true});
    if (context.signal.aborted || !context.isCurrent()) this.cancel();
  }
  private decision(disposition: TitleDecision['disposition'], command?: TitleCommand): TitleDecision {
    return {disposition, mode: this.mode, requireTargetDrain: this.drainRequired, ...(command ? {command: structuredClone(command)} : {})};
  }
  private timeValid(now: number): boolean {
    if (!Number.isFinite(now) || now < this.lastTime) return false;
    this.lastTime = now; return true;
  }
  private scopeValid(scope: TitleScope, now: number): boolean {
    const r = scope.canvas;
    return ownerMatches(this.owner, scope) && scope.uid === 502 && scope.effectiveUid === 502 && scope.consoleUid === 502 &&
      scope.canonicalExecutable === true && scope.active === true && scope.visible === true && scope.complete === true &&
      scope.titleDialogConfirmed === true && scope.nestedModal === false && scope.textEditing === false &&
      typeof scope.focusEpoch === 'string' && scope.focusEpoch.length > 0 &&
      Number.isFinite(scope.observedAt) && scope.observedAt <= now && now - scope.observedAt <= 100 &&
      !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
  }
  private invalidate(): void {
    // An issued command may already be queued; middle-down cannot be recalled.
    if (this.pending || this.gesture === 'pan') this.drainRequired = true;
    // Keep ownership of the physical key/button sequences we already consumed.
    // Their later repeats/drag/up must not leak as unmatched native events.
    this.pending = undefined; this.gesture = undefined; this.gestureCanvas = undefined; this.mode = 'selection'; this.modeEpoch = undefined;
  }
  private issue(event: TitleInputEvent, scope: TitleScope, now: number, effect: Omit<Extract<TitleCommand, {kind:'activate-object-selection'}>, 'id'|'guard'> |
    Omit<Extract<TitleCommand, {kind:'focus-object-transform'}>, 'id'|'guard'> |
    Omit<Extract<TitleCommand, {kind:'middle-pointer'}>, 'id'|'guard'> |
    Omit<Extract<TitleCommand, {kind:'step-viewport-zoom'}>, 'id'|'guard'>, nextMode = this.mode): TitleDecision {
    const guard: TitleGuard = {...this.owner, routerId:this.routerId, runId:this.context.runId, requestId:this.context.requestId, generation:this.context.generation,
      focusEpoch:scope.focusEpoch, eventId:event.id, expiresAt:now + 100, canvas:{...scope.canvas},
      physicalButtons:[...scope.physicalButtons as readonly ('left' | 'middle' | 'right')[]]};
    const command: TitleCommand = {...effect, id:`${this.routerId}/${++this.nextCommand}`, guard};
    this.pending = {command, nextMode};
    return this.decision(event.kind === 'pointer' && effect.kind === 'middle-pointer' ? 'replace' : 'consume', command);
  }
  handle(event: TitleInputEvent, scope: TitleScope, now: number): TitleDecision {
    // Replacement events can reenter an OS callback. They are not physical input
    // and must not cancel a pending command or advance the physical sequence.
    if (event.injected === true) return this.decision('pass');
    const ownsContinuation = event.kind === 'pointer' && event.button === 'left' && this.capturedLeft || event.kind === 'key' && this.consumedKeys.has(event.key);
    // Invalid/stale ups cannot release ownership of a real physical sequence.
    const eventValid = Number.isSafeInteger(event.id) && event.id > this.lastEvent && event.injected === false && validModifiers(event.modifiers) &&
      (event.kind === 'key' ? ['down','up'].includes(event.phase) && typeof event.key === 'string' && typeof event.repeat === 'boolean' :
        event.kind === 'pointer' && ['down','drag','up'].includes(event.phase) && ['left','middle','right'].includes(event.button) && [event.x,event.y].every(Number.isFinite));
    if (!this.timeValid(now) || !eventValid) {
      this.invalidate(); return this.decision(ownsContinuation ? 'consume' : 'pass');
    }
    this.lastEvent = event.id;
    if (event.kind === 'pointer' && event.button === 'left' && event.phase === 'up') this.capturedLeft = false;
    if (event.kind === 'key' && event.phase === 'up') this.consumedKeys.delete(event.key);
    if (this.revoked || this.context.signal.aborted || !this.context.isCurrent()) {
      this.cancel(); return this.decision(ownsContinuation ? 'consume' : 'pass');
    }
    if (this.pending || !this.scopeValid(scope, now) || scope.focus !== 'canvas' || this.modeEpoch && scope.focusEpoch !== this.modeEpoch ||
      this.gestureCanvas && (Object.keys(this.gestureCanvas) as (keyof TitleScope['canvas'])[]).some(k => scope.canvas[k] !== this.gestureCanvas![k])) {
      this.invalidate(); return this.decision(ownsContinuation ? 'consume' : 'pass');
    }
    if (this.drainRequired) return this.decision(ownsContinuation ? 'consume' : 'pass');
    const buttons = scope.physicalButtons;
    const buttonsKnown = Array.isArray(buttons) && new Set(buttons).size === buttons.length && buttons.every(b => ['left','middle','right'].includes(b));
    const leftOnly = buttonsKnown && buttons.length === 1 && buttons[0] === 'left';
    const noButtons = buttonsKnown && buttons.length === 0;
    if (event.kind === 'key') {
      if (event.phase === 'up') return this.decision(ownsContinuation ? 'consume' : 'pass');
      if (ownsContinuation) return this.decision('consume');
      if (event.key === 'Escape' && event.modifiers.length === 0 && this.gesture) {
        this.consumedKeys.add(event.key); this.invalidate(); return this.decision('consume');
      }
      if (event.repeat || this.gesture || !noButtons) return this.decision('pass');
      if (event.key === 'Escape' && event.modifiers.length === 0 && this.mode !== 'selection') {
        this.mode = 'selection'; this.modeEpoch = undefined; this.consumedKeys.add(event.key); return this.decision('consume');
      }
      const action = this.bindings.get(chord(event.key, event.modifiers));
      if (!action) return this.decision('pass');
      this.consumedKeys.add(event.key);
      // Source binding wins even when no object can be transformed. Passing
      // Meta+T here would activate Kdenlive's unrelated native text tool.
      if (action === 'transform' && !scope.selectedObject) return this.decision('consume');
      if (action === 'pan' || action === 'zoom') {this.mode = action; this.modeEpoch = scope.focusEpoch; return this.decision('consume');}
      if (action === 'transform') return this.issue(event, scope, now, {kind:'focus-object-transform',selectedObject:scope.selectedObject!}, 'transform');
      return this.issue(event, scope, now, {kind:'activate-object-selection'}, 'selection');
    }
    if (ownsContinuation && !this.gesture) return this.decision('consume');
    if (this.gesture === 'pan') {
      if (event.button !== 'left' || event.modifiers.length || event.phase === 'down' || !(event.phase === 'up' ? noButtons : leftOnly)) {
        this.invalidate();return this.decision(ownsContinuation ? 'consume' : 'pass');
      }
      // Same owned title gesture may finish outside the canvas; no new down there.
      return this.issue(event, scope, now, {kind:'middle-pointer',phase:event.phase,x:event.x,y:event.y});
    }
    if (event.button !== 'left') return this.decision('pass');
    if (this.gesture === 'zoom') {
      if (event.phase === 'up') {this.gesture = undefined;this.gestureCanvas = undefined;}
      return this.decision('consume');
    }
    const r = scope.canvas;
    const inside = event.x >= r.x && event.y >= r.y && event.x < r.x + r.width && event.y < r.y + r.height;
    if (!inside || event.phase !== 'down' || !leftOnly) return this.decision('pass');
    if (this.mode === 'pan' && event.modifiers.length === 0) {
      this.gesture = 'pan'; this.capturedLeft = true; this.gestureCanvas = {...scope.canvas};
      return this.issue(event, scope, now, {kind:'middle-pointer',phase:'down',x:event.x,y:event.y});
    }
    if (this.mode === 'zoom' && event.modifiers.every(m => m === 'Alt')) {
      this.gesture = 'zoom'; this.capturedLeft = true; this.gestureCanvas = {...scope.canvas};
      return this.issue(event, scope, now, {kind:'step-viewport-zoom',direction:event.modifiers.includes('Alt') ? -1 : 1});
    }
    return this.decision('pass');
  }
  settle(commandId: string, outcome: 'performed' | 'not-dispatched' | 'uncertain', scope: TitleScope, now: number): TitleDecision {
    const pending = this.pending;
    if (!pending || pending.command.id !== commandId) {
      // A late/foreign receipt must not clear a cancellation or a newer command.
      this.invalidate(); this.drainRequired = true; return this.decision('pass');
    }
    if (!this.timeValid(now) || this.revoked || this.context.signal.aborted || !this.context.isCurrent() ||
      !this.scopeValid(scope, now) || now >= pending.command.guard.expiresAt ||
      (Object.keys(pending.command.guard.canvas) as (keyof TitleScope['canvas'])[]).some(k => scope.canvas[k] !== pending.command.guard.canvas[k]) ||
      !Array.isArray(scope.physicalButtons) || scope.physicalButtons.length !== pending.command.guard.physicalButtons.length ||
      scope.physicalButtons.some(b => !pending.command.guard.physicalButtons.includes(b)) ||
      (pending.command.kind !== 'focus-object-transform' && (scope.focusEpoch !== pending.command.guard.focusEpoch || scope.focus !== 'canvas')) ||
      (pending.command.kind === 'focus-object-transform' && (scope.focus !== 'transform-controls' || scope.selectedObject !== pending.command.selectedObject))) {
      this.invalidate(); this.drainRequired = true; return this.decision('pass');
    }
    if (outcome === 'uncertain') {this.invalidate();this.drainRequired = true;return this.decision('pass');}
    this.pending = undefined;
    if (outcome === 'not-dispatched') {
      if (pending.command.kind === 'middle-pointer' && pending.command.phase !== 'down') this.drainRequired = true;
      this.gesture = undefined; this.gestureCanvas = undefined; this.mode = 'selection'; this.modeEpoch = undefined;
    } else if (outcome === 'performed') {
      this.mode = pending.nextMode;
      this.modeEpoch = scope.focusEpoch;
      if (pending.command.kind === 'middle-pointer' && pending.command.phase === 'up') {this.gesture = undefined;this.gestureCanvas = undefined;}
    } else {this.invalidate();this.drainRequired = true;}
    return this.decision('pass');
  }
  /** Revocation is terminal. Reset must create a new router after native drain. */
  cancel(): TitleDecision {
    this.revoked = true; this.invalidate();
    this.context.signal.removeEventListener('abort', this.onAbort);
    return this.decision('pass');
  }
  /** host may clear the drain latch only after independently awaiting owned target
   * exit; this does not reactivate the router or prove baseline restoration. */
  confirmTargetExited(owner: TitleOwner): void {
    if (!this.revoked || !ownerMatches(owner, this.owner)) throw new Error('KDENLIVE_TITLE_DRAIN_IDENTITY');
    this.drainRequired = false;
  }
}
