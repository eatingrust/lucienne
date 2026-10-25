import type { RunEvent } from '../contracts/index.js';
import { durationMs } from './performance.ts';

export interface LifecycleFinding {
  id: string;
  status: 'pass' | 'fail' | 'blocked';
  detail: string;
}
export interface LifecycleMetric { name: string; value: number; unit: 'ms' | 'count' }
interface Check { failures: string[]; missing: string[]; observed: boolean }

// emit() samples the monotonic clock and remaining deadline separately. This is
// a numerical sampling allowance, not a latency SLO or extra visitor time.
export const TIMER_SAMPLE_TOLERANCE_MS = 1;
const near = (actual: number, expected: number) => Number.isFinite(actual) && Math.abs(actual - expected) <= TIMER_SAMPLE_TOLERANCE_MS;

/** Audits the host v1 SessionCoordinator event contract. A passing trace is never
 * native-app proof: task/readback/reset artifacts need independent verification.
 * The envelope must attest that all events originate from this single monotonic
 * clock. RunEvent has no clockId; network arrival times must not be substituted.
 */
export function auditLifecycle(events: readonly RunEvent[], context: {
  clockId: string; runId: string; scenarioId: string;
  /** QA-only derivation from verified before/after commit receipts. RunEvent does
   * not carry whether a chat actually changed native operations. */
  chatChanges?: ReadonlyMap<string, boolean>;
}): { findings: LifecycleFinding[]; metrics: LifecycleMetric[] } {
  const ids = ['identity', 'sequence', 'monotonic-clock', 'generation-isolation', 'readiness-timer', 'chat-pause', 'closing-overlay', 'reset-completion', 'reported-errors'] as const;
  const checks = Object.fromEntries(ids.map(id => [id, { failures: [], missing: [], observed: false }])) as unknown as Record<typeof ids[number], Check>;
  const metrics: LifecycleMetric[] = [{ name: 'lifecycle-event-count', value: events.length, unit: 'count' }];
  const fail = (id: typeof ids[number], message: string) => checks[id].failures.push(message);
  const missing = (id: typeof ids[number], message: string) => checks[id].missing.push(message);
  const observed = (id: typeof ids[number]) => { checks[id].observed = true; };
  const finiteTime = (e: RunEvent) => Number.isFinite(e.monotonicMs) && e.monotonicMs >= 0;
  const elapsed = (a: RunEvent, b: RunEvent): number | null => {
    try { return durationMs({ clockId: context.clockId, ms: a.monotonicMs }, { clockId: context.clockId, ms: b.monotonicMs }); }
    catch { return null; }
  };
  if (!context.runId || !context.scenarioId) fail('identity', 'Expected run/scenario identity is missing.');
  if (!context.clockId.trim()) fail('monotonic-clock', 'A single originating monotonic clock ID is required.');
  if (events.length) {
    observed('identity'); observed('sequence'); observed('monotonic-clock'); observed('generation-isolation'); observed('reported-errors');
  }
  if (events[0]?.type !== 'selected') missing('sequence', 'The selected event is missing at the start of this run.');
  const eventIds = new Set<string>();
  const phases: Record<RunEvent['type'], readonly string[]> = {
    selected: ['selected'], planning: ['planning', 'chat'], progress: ['planning', 'chat'], applying: ['applying', 'chat'],
    'target-ready': ['ready'], 'chat-opened': ['chat'], 'chat-applied': ['ready'], 'chat-closed': ['ready'],
    closing: ['closing'], 'reset-started': ['resetting'], 'reset-completed': ['idle'], failed: ['selected', 'ready', 'error'],
  };
  let generation: number | undefined;
  let ready: RunEvent | undefined;
  let timerAnchor: RunEvent | undefined;
  let paused: RunEvent | undefined;
  let closing: RunEvent | undefined;
  let resetStarted: RunEvent | undefined;
  let resetCompleted: RunEvent | undefined;
  let resetEverStarted = false;
  let resetAttempts = 0;
  let chatCompleted = 0;
  const plans = new Map<string, RunEvent>();
  const applied = new Set<string>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const previous = events[index - 1];
    const label = `sequence ${event.sequence}`;
    if (event.runId !== context.runId || event.scenarioId !== context.scenarioId) fail('identity', `${label}: foreign run/scenario.`);
    if (index && (event.target.appId !== events[0]!.target.appId || event.target.adapterVersion !== events[0]!.target.adapterVersion)) fail('identity', `${label}: target/adapter changed inside the run.`);
    if (!phases[event.type]?.includes(event.phase)) fail('identity', `${label}: event type and phase disagree.`);
    if (!event.eventId || eventIds.has(event.eventId)) fail('sequence', `${label}: missing or duplicate event ID.`);
    eventIds.add(event.eventId);
    if (!Number.isInteger(event.sequence) || event.sequence <= 0 || (previous && event.sequence <= previous.sequence)) fail('sequence', `${label}: event sequence is invalid or out of order.`);
    else if (event.sequence !== (previous?.sequence ?? 0) + 1) missing('sequence', `${label}: one or more preceding events are absent.`);
    if (!finiteTime(event) || (previous && event.monotonicMs < previous.monotonicMs)) fail('monotonic-clock', `${label}: invalid or reversed monotonic timestamp.`);
    if (!Number.isFinite(event.remainingMs) || event.remainingMs < 0 || event.remainingMs > 60_000) fail('readiness-timer', `${label}: remaining time is outside 0–60000 ms.`);
    if (!Number.isInteger(event.generation) || event.generation < 1) fail('generation-isolation', `${label}: generation must be a positive integer in an active host run.`);
    if (generation !== undefined) {
      const expected = generation + (event.type === 'reset-started' ? 1 : 0);
      if (event.generation !== expected) fail('generation-isolation', `${label}: generation changed without the expected reset invalidation.`);
    }
    generation = event.generation;
    if (resetCompleted) fail('generation-isolation', `${label}: an event arrived after this run completed reset.`);
    if (resetEverStarted && !['reset-started', 'reset-completed', 'failed'].includes(event.type)) fail('generation-isolation', `${label}: stale work was emitted after reset began.`);
    if (event.type === 'selected' && index !== 0) fail('identity', `${label}: this run was selected more than once.`);
    if (!ready && !resetEverStarted && !['reset-started', 'reset-completed', 'target-ready'].includes(event.type)) {
      if (!near(event.remainingMs, 60_000)) fail('readiness-timer', `${label}: exploration time was consumed before target readiness.`);
    }
    if (event.type === 'failed') {
      fail('reported-errors', `${label}: ${event.code ?? 'UNSPECIFIED_FAILURE'} (retained even if a later retry succeeds).`);
      if (paused && event.phase === 'ready') {
        if (!near(event.remainingMs, paused.remainingMs)) fail('chat-pause', `${label}: failed chat consumed paused time.`);
        timerAnchor = event; paused = undefined;
      }
    }
    if (paused && event.phase === 'chat' && event.type !== 'chat-opened' && !near(event.remainingMs, paused.remainingMs)) fail('chat-pause', `${label}: timer ran while chat was open.`);
    if (event.type === 'planning') {
      if (!event.requestId) fail('identity', `${label}: planning has no request identity.`);
      else {
        if (plans.has(event.requestId)) fail('identity', `${label}: request ID was reused for planning.`);
        plans.set(event.requestId, event);
      }
    }
    if (event.type === 'applying') {
      if (!event.requestId || !plans.has(event.requestId)) missing('readiness-timer', `${label}: matching planning event is missing.`);
      if (event.requestId) applied.add(event.requestId);
    }
    if (event.type === 'target-ready') {
      observed('readiness-timer');
      if (ready) fail('readiness-timer', `${label}: initial readiness was emitted more than once.`);
      if (!near(event.remainingMs, 60_000)) fail('readiness-timer', `${label}: readiness did not start with 60000 ms (1 ms sampling allowance).`);
      const plan = event.requestId ? plans.get(event.requestId) : undefined;
      if (!plan || plan.phase !== 'planning' || !event.requestId || !applied.has(event.requestId)) missing('readiness-timer', `${label}: initial planning/apply evidence is incomplete.`);
      else {
        const value = elapsed(plan, event);
        if (value !== null) metrics.push({ name: 'translate-to-ready', value, unit: 'ms' });
      }
      ready = event; timerAnchor = event;
      if (!event.evidenceRefs.length) missing('readiness-timer', `${label}: readiness has no readback evidence references.`);
    }
    if (event.type === 'chat-opened') {
      observed('chat-pause');
      if (!ready || !timerAnchor) missing('chat-pause', `${label}: no prior ready timer to audit.`);
      else {
        const value = elapsed(timerAnchor, event);
        if (value !== null && !near(event.remainingMs, Math.max(0, timerAnchor.remainingMs - value))) fail('chat-pause', `${label}: opening chat did not freeze the remaining exploration deadline.`);
      }
      if (paused) fail('chat-pause', `${label}: chat opened while already paused.`);
      if (event.remainingMs <= 0) fail('chat-pause', `${label}: expired exploration entered chat.`);
      paused = event;
    }
    if (event.type === 'chat-applied' || event.type === 'chat-closed') {
      observed('chat-pause');
      if (!paused) missing('chat-pause', `${label}: matching chat-opened event is absent.`);
      else {
        const changed = event.type === 'chat-applied' && event.requestId ? context.chatChanges?.get(event.requestId) : false;
        if (event.type === 'chat-applied' && paused.remainingMs < 30_000 && changed === undefined) {
          if (!near(event.remainingMs, paused.remainingMs) && !near(event.remainingMs, 30_000)) fail('chat-pause', `${label}: resumed time matches neither a no-op nor a changed chat.`);
          missing('chat-pause', `${label}: verified operation-change evidence is required to audit the late-chat floor.`);
        } else {
          const expected = changed === true ? Math.max(paused.remainingMs, 30_000) : paused.remainingMs;
          if (!near(event.remainingMs, expected)) fail('chat-pause', `${label}: chat did not resume its paused time${changed === true ? ' with the 30000 ms change floor' : ' without an unearned extension'}.`);
        }
        chatCompleted += 1;
      }
      if (event.type === 'chat-applied') {
        const plan = event.requestId ? plans.get(event.requestId) : undefined;
        if (!plan || plan.phase !== 'chat' || !event.requestId || !applied.has(event.requestId)) missing('chat-pause', `${label}: chat planning/apply evidence is incomplete.`);
      }
      paused = undefined; timerAnchor = event;
    }
    if (event.type === 'closing') {
      observed('closing-overlay');
      if (paused) fail('chat-pause', `${label}: exploration closed while chat was paused.`);
      if (!timerAnchor) missing('closing-overlay', `${label}: ready timer anchor is missing.`);
      else {
        const value = elapsed(timerAnchor, event);
        if (value !== null && value + TIMER_SAMPLE_TOLERANCE_MS < timerAnchor.remainingMs) fail('closing-overlay', `${label}: closing began before exploration expired.`);
      }
      if (event.remainingMs !== 0) fail('closing-overlay', `${label}: closing retained exploration time.`);
      if (closing) fail('closing-overlay', `${label}: closing began more than once.`);
      closing = event;
    }
    if (event.type === 'reset-started') {
      observed('reset-completion'); resetAttempts += 1;
      if (resetStarted) fail('reset-completion', `${label}: a new reset began before the prior attempt settled.`);
      if (event.remainingMs !== 0) fail('reset-completion', `${label}: resetting retained visitor time.`);
      if (closing && !resetEverStarted) {
        const value = elapsed(closing, event);
        if (value !== null) {
          metrics.push({ name: 'closing-visible', value, unit: 'ms' });
          if (value + TIMER_SAMPLE_TOLERANCE_MS < 20_000) missing('closing-overlay', 'Closing lasted under 20000 ms; v1 events omit the reset reason, so operator reset cannot be distinguished from early expiry.');
        }
      }
      resetEverStarted = true; resetStarted = event; paused = undefined;
    }
    if (event.type === 'failed' && resetStarted) {
      fail('reset-completion', `${label}: reset attempt failed (${event.code ?? 'UNSPECIFIED_FAILURE'}).`);
      resetStarted = undefined;
    }
    if (event.type === 'reset-completed') {
      observed('reset-completion');
      if (!resetStarted) missing('reset-completion', `${label}: matching reset-started event is missing.`);
      else {
        const value = elapsed(resetStarted, event);
        if (value !== null) metrics.push({ name: 'reset-duration', value, unit: 'ms' });
      }
      if (!near(event.remainingMs, 60_000)) fail('reset-completion', `${label}: idle state did not restore a fresh 60000 ms timer.`);
      if (!event.evidenceRefs.length) missing('reset-completion', `${label}: reset completion has no evidence references.`);
      resetCompleted = event; resetStarted = undefined;
    }
  }
  if (!ready) missing('readiness-timer', 'No target-ready event; native readiness and timer start are unproven.');
  if (!chatCompleted) missing('chat-pause', 'No completed chat pause/resume was observed.');
  if (!closing) missing('closing-overlay', 'No closing overlay interval was observed.');
  else if (!resetEverStarted) missing('closing-overlay', 'Closing has no reset boundary yet.');
  if (!resetCompleted) missing('reset-completion', 'Reset completion is missing; cleanup/desktop return remain unproven.');
  if (checks.sequence.missing.length) {
    for (const id of ['generation-isolation', 'readiness-timer', 'chat-pause', 'closing-overlay', 'reset-completion'] as const) missing(id, 'Event stream has gaps; complete lifecycle evidence is required.');
  }
  metrics.push({ name: 'reset-attempt-count', value: resetAttempts, unit: 'count' });
  return {
    findings: ids.map((id): LifecycleFinding => {
      const check = checks[id];
      return { id: `lifecycle.${id}`, status: check.failures.length ? 'fail' : check.missing.length || !check.observed ? 'blocked' : 'pass',
        detail: [...check.failures, ...check.missing].join(' ') || (check.observed ? 'Observed trace is consistent; this alone is not native behavior proof.' : 'No observations supplied.') };
    }),
    metrics,
  };
}
