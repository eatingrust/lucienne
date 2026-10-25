import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runKritaQA, type KritaRunOptions } from '../../../qa/krita-runner.js';
import { runNativeQA, type NativeRunOptions, type RelaunchClosure } from '../../../qa/native-runner.js';
import { verifyArtifacts, type EvidenceArtifact } from '../../../qa/artifacts.js';
import type { RuntimeState } from '../../../contracts/bridge.js';

type State = RuntimeState['qa'];
type Gate = { id: string; resolve(): void; reject(error: Error): void; signal?: AbortSignal; abort(): void; timer: ReturnType<typeof setTimeout> };
export type NativeQAAttempt =
  | { target: 'krita'; options: Omit<KritaRunOptions, 'signal' | 'onStage'> }
  | { target: 'blender'; options: Omit<NativeRunOptions, 'signal' | 'onStage'> };
type NativeQARunners = { krita: typeof runKritaQA; blender: typeof runNativeQA };
/** Operator gestures remain real. A button only ends a wait; native QA checks native
 * pixels/selection/bounds afterward. Relaunch additionally requires actual UI evidence. */
export class NativeQAController {
  readonly state: State;
  private gate?: Gate;
  private controller?: AbortController;
  private completion: Promise<void> = Promise.resolve();
  constructor(enabled: boolean, private readonly changed: () => void,
    private readonly runners: NativeQARunners = { krita: runKritaQA, blender: runNativeQA }) {
    this.state = { enabled, running: false, stage: 'not-started', pending: null, result: null };
  }
  waitForOperator(instruction: string, signal?: AbortSignal): Promise<void> {
    signal ??= this.controller?.signal;
    if (this.gate) throw new Error('QA_STEP_ALREADY_PENDING');
    if (signal?.aborted) return Promise.reject(new Error('QA_ABORTED'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => { this.finishGate(); reject(new Error('QA_ABORTED')); };
      const timer = setTimeout(() => { this.finishGate(); reject(new Error('QA_OPERATOR_TIMEOUT')); }, 90_000);
      this.gate = { id, resolve, reject, signal, abort, timer };
      this.state.pending = { id, instruction };
      signal?.addEventListener('abort', abort, { once: true });
      this.changed();
    });
  }
  private finishGate() {
    const gate = this.gate;
    if (gate) clearTimeout(gate.timer);
    gate?.signal?.removeEventListener('abort', gate.abort);
    this.gate = undefined; this.state.pending = null; this.changed();
    return gate;
  }
  complete(id: string): void {
    if (!this.gate || this.gate.id !== id) throw new Error('QA_STEP_STALE');
    this.finishGate()?.resolve();
  }
  abort(): void { this.controller?.abort(); }
  async cancelAndWait(): Promise<void> { this.abort(); await this.completion; }
  start(attempt: NativeQAAttempt): void {
    if (!this.state.enabled || this.state.running || this.state.stage !== 'not-started') throw new Error('QA_START_REJECTED');
    this.controller = new AbortController(); this.state.running = true; this.state.stage = 'starting';
    const common = { signal: this.controller.signal,
      onStage: (stage: string) => { this.state.stage = stage; this.changed(); } };
    this.completion = Promise.resolve().then(() => attempt.target === 'krita'
      ? this.runners.krita({ ...attempt.options, ...common })
      : this.runners.blender({ ...attempt.options, ...common })
    ).then(result => { this.state.result = `${result.status}: ${result.errorCode ?? result.capturePath}`; }, () => {
      this.state.result = 'QA_CAPTURE_FAILED';
    }).finally(() => { this.state.running = false; this.finishGate(); this.changed(); });
    this.changed();
  }
}

const closedRelaunch = z.object({
  baselineCompared: z.literal(true), visitorStateCleared: z.literal(true),
  recentsCleared: z.literal(true), targetClosed: z.literal(true), sessionAbsent: z.literal(true),
  evidenceRefs: z.array(z.string().min(1)).min(1),
});

/** A resolved inspection is insufficient: every independent closure check must pass. */
export class OrdinaryRelaunchObligation {
  private outstanding = false;
  private generation = 0;
  private inspect?: () => Promise<RelaunchClosure>;
  private label = 'the target application';
  get pending(): boolean { return this.outstanding; }
  get targetLabel(): string { return this.label; }
  begin(label: string, inspect: () => Promise<RelaunchClosure>): void {
    if (this.outstanding) throw new Error('ORDINARY_RELAUNCH_ALREADY_PENDING');
    this.inspect = inspect; this.label = label; this.outstanding = true; this.generation++;
  }
  async verifyClosed(): Promise<RelaunchClosure> {
    if (!this.outstanding || !this.inspect) throw new Error('ORDINARY_RELAUNCH_NOT_PENDING');
    const generation = this.generation;
    try {
      const observed = closedRelaunch.parse(await this.inspect());
      if (this.generation !== generation) throw new Error('STALE_RELAUNCH_INSPECTION');
      this.outstanding = false;
      return observed;
    } catch {
      throw new Error('ORDINARY_RELAUNCH_RECOVERY_REQUIRED');
    }
  }
}

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:/-]+$/);
const artifact = z.strictObject({ id, path: z.string().min(1).max(1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  buildId: id, runId: id, evidenceKind: z.literal('native') });
const relaunch = z.strictObject({ version: z.literal(1), buildId: id, runId: id, method: z.literal('independent-macos-ui'),
  targetVisible: z.literal(true), interactive: z.literal(true), baselineCompared: z.literal(true), visitorStateAbsent: z.literal(true),
  evidenceRefs: z.array(id).min(1).max(16), artifacts: z.array(artifact).min(1).max(16) });

/** The operator writes this only after independently observing a normal launch.
 * Never create it from successful process launch, a reset receipt, or button click. */
export async function readOrdinaryRelaunchEvidence(root: string, identity: { runId: string; buildId: string }) {
  const handle = await open(path.join(root, 'ordinary-relaunch.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: unknown;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('RELAUNCH_EVIDENCE_INVALID');
    raw = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  const value = relaunch.parse(raw);
  if (value.buildId !== identity.buildId || value.runId !== identity.runId || value.artifacts.some(a => a.buildId !== identity.buildId || a.runId !== identity.runId))
    throw new Error('RELAUNCH_EVIDENCE_WRONG_RUN');
  const checked = await verifyArtifacts(root, value.artifacts, identity);
  if (checked.some(a => a.status !== 'pass') || value.evidenceRefs.some(ref => !value.artifacts.some(a => a.id === ref))) throw new Error('RELAUNCH_EVIDENCE_UNVERIFIED');
  const artifacts: EvidenceArtifact[] = value.artifacts;
  return { receipt: { targetVisible: value.targetVisible, interactive: value.interactive,
    baselineCompared: value.baselineCompared, visitorStateAbsent: value.visitorStateAbsent, evidenceRefs: value.evidenceRefs }, artifacts };
}
