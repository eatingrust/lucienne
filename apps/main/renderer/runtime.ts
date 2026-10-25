import { useEffect, useState } from 'react';
import type { Command, DesktopBridge, RuntimeState } from '../../../contracts/bridge.js';

export interface BridgeView {
  runtime: RuntimeState | null;
  error: string | null;
  pending: Command['type'] | null;
}

const selectionCommands: readonly Command['type'][] = ['select-scenario', 'select-krita', 'select-fixture'];
const optionalCommands: readonly Command['type'][] = [
  'preparation-status', 'prepare-context', 'quiz-start', 'quiz-answer', 'quiz-accept', 'quiz-cancel',
];

/** Presentation transport only. Native operations, cancellation and time belong to the host. */
export class RuntimeClient {
  private view: BridgeView = { runtime: null, error: null, pending: null };
  private listeners = new Set<(view: BridgeView) => void>();
  private revision = 0;
  private commandEpoch = 0;
  private connectionEpoch = 0;
  private expectedResetKey: number | null = null;
  private unsubscribe?: () => void;
  constructor(private readonly bridge?: DesktopBridge) {}
  snapshot = (): BridgeView => this.view;
  subscribe = (listener: (view: BridgeView) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(next: Partial<BridgeView>): void {
    this.view = { ...this.view, ...next };
    this.listeners.forEach(listener => listener(this.view));
  }
  private receive(runtime: RuntimeState): void {
    this.revision++;
    const previousRuntime = this.view.runtime;
    const previous = previousRuntime?.snapshot;
    const next = runtime.snapshot;
    // A host reset/new run invalidates old command replies; no renderer cancellation authority.
    const resetBoundary = previous && ((previous.runId !== next.runId) ||
      (previous.phase !== next.phase && ['resetting', 'idle'].includes(next.phase)));
    const ownSelection = next.phase === 'selected' && previous?.phase === 'idle' && selectionCommands.includes(this.view.pending!);
    const previousKey = previousRuntime?.quiz?.resetKey;
    const nextKey = runtime.quiz?.resetKey;
    const serviceBoundary = previousKey !== undefined && nextKey !== undefined && previousKey !== nextKey;
    // A fresh prepareSelection/cancelPreparation advances the host generation once.
    // Their own publication must not hide the command's cleanup failure or acknowledgment.
    const ownServiceBoundary = serviceBoundary && nextKey === this.expectedResetKey;
    if (serviceBoundary) this.expectedResetKey = null;
    if (((resetBoundary && !ownSelection) || (serviceBoundary && !ownServiceBoundary)) && this.view.pending !== 'reset') {
      this.commandEpoch++;
      this.expectedResetKey = null;
      this.update({ runtime, pending: null, error: null });
    } else this.update({ runtime });
  }
  connect = async (): Promise<void> => {
    if (!this.bridge) return;
    this.update({ error: null });
    this.unsubscribe?.();
    const connection = ++this.connectionEpoch;
    const initialRevision = this.revision;
    try {
      this.unsubscribe = this.bridge.subscribe(runtime => {
        if (connection === this.connectionEpoch) this.receive(runtime);
      });
      const runtime = await this.bridge.getState();
      if (connection === this.connectionEpoch && this.revision === initialRevision) this.receive(runtime);
    } catch {
      if (connection === this.connectionEpoch && this.revision === initialRevision) this.update({ error: 'BRIDGE_UNAVAILABLE' });
    }
  };
  disconnect = (): void => {
    this.connectionEpoch++; this.commandEpoch++;
    this.expectedResetKey = null;
    this.unsubscribe?.(); this.unsubscribe = undefined;
  };
  send = async (command: Command): Promise<boolean> => {
    const pending = this.view.pending;
    if (!this.bridge || pending === 'reset') return false;
    if (command.type === 'quiz-cancel') {
      const current = this.view.runtime?.quiz?.state;
      if (!current || !['running', 'question', 'complete', 'error'].includes(current.status) ||
          command.quizId !== current.quizId || command.requestId !== current.requestId ||
          command.sourceProfileId !== current.sourceProfileId || command.sourceRevision !== current.sourceRevision) return false;
    }
    if (pending && command.type !== 'reset' &&
        !(command.type === 'quiz-cancel' && ['quiz-start', 'quiz-answer', 'quiz-accept'].includes(pending)) &&
        !(command.type === 'cancel-preparation' && optionalCommands.includes(pending))) return false;
    const epoch = ++this.commandEpoch;
    const resetKey = this.view.runtime?.quiz?.resetKey;
    const quiz = this.view.runtime?.quiz;
    const preparation = this.view.runtime?.services?.preparation;
    // A cancellation may join an existing host cleanup without advancing its key.
    // These fields also admit some unavailable-service states: conservatively avoid
    // attributing a later generation to our command when cleanup may already exist.
    const mayJoinCleanup = preparation?.busy && preparation.context.status === 'none' &&
      quiz?.available === false && quiz.state === null;
    this.expectedResetKey = resetKey !== undefined &&
      ((command.type === 'cancel-preparation' && !mayJoinCleanup) || selectionCommands.includes(command.type))
      ? resetKey + 1 : null;
    this.update({ pending: command.type, error: null });
    try {
      const reply = await this.bridge.command(command);
      if (epoch !== this.commandEpoch) return false;
      if (!reply.ok) this.update({ error: reply.code ?? 'COMMAND_REJECTED' });
      return reply.ok;
    } catch {
      if (epoch === this.commandEpoch) this.update({ error: 'BRIDGE_UNAVAILABLE' });
      return false;
    } finally {
      if (epoch === this.commandEpoch) { this.expectedResetKey = null; this.update({ pending: null }); }
    }
  };
}

export function useRuntime(bridge?: DesktopBridge) {
  const [client] = useState(() => new RuntimeClient(bridge));
  const [view, setView] = useState(client.snapshot);
  useEffect(() => {
    const unsubscribe = client.subscribe(setView);
    void client.connect();
    return () => { unsubscribe(); client.disconnect(); };
  }, [client]);
  return { ...view, send: client.send, reconnect: client.connect };
}
