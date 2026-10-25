/** QA measurements, not a second product event schema. Event producers supply their
 * local monotonic clock identity; wall time, remote events and unrelated processes
 * must not be subtracted from one another. Build/run IDs belong to the evidence
 * envelope that stores these measurements. */
export interface MonotonicStamp {
  clockId: string;
  ms: number;
}

function assertNonnegativeFinite(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_MONOTONIC_VALUE');
}

export function durationMs(start: MonotonicStamp, end: MonotonicStamp): number {
  if (!start.clockId.trim() || start.clockId !== end.clockId) throw new Error('CLOCK_MISMATCH');
  assertNonnegativeFinite(start.ms);
  assertNonnegativeFinite(end.ms);
  if (end.ms < start.ms) throw new Error('CLOCK_REVERSED');
  return end.ms - start.ms;
}

export interface Distribution {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/** Nearest-rank empirical quantiles. Always retain n; one observation is not an
 * estimate of the population's tail. Empty samples stay null, never zero. */
export function summarizeMeasurements(samples: readonly number[]): Distribution {
  samples.forEach(assertNonnegativeFinite);
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, p50: null, p95: null, max: null };
  const rank = (fraction: number) => sorted[Math.ceil(fraction * sorted.length) - 1]!;
  return { n: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1]! };
}

/** A diagnostic frame-gap cutoff, NOT an approved product performance SLO. */
export const FRAME_GAP_DIAGNOSTIC_MS = 50;

export interface FrameScheduler {
  /** Same renderer's requestAnimationFrame callback/time origin for the capture. */
  requestFrame(callback: (timestampMs: number) => void): number;
  cancelFrame(handle: number): void;
  isVisible(): boolean;
  /** Must subscribe to visibility changes, including those between two frames. */
  subscribeVisibilityChange(callback: () => void): () => void;
}

export interface FrameMeasurement {
  scope: 'renderer-request-animation-frame';
  nativeResponsivenessVerified: false;
  active: boolean;
  visibleFrames: number;
  visibleFrameGapsMs: Distribution;
  gapsOver50Ms: number;
  hiddenIntervals: number;
  excludedHiddenCallbacks: number;
  excludedMissingIntervals: number;
  invalidTimestamps: number;
}

/** Measures gaps between consecutive visible renderer frames. It cannot prove a
 * native creative app is interactive and does not measure GPU presentation time.
 * Hidden intervals, explicitly reported capture gaps and invalid/backwards clock
 * readings break continuity. Unreported lost callbacks cannot be distinguished
 * from a real stall: capture reliability must remain in the evidence limitations.
 * Supply browser functions bound to their owner, plus a visibilitychange listener.
 */
export function startFrameMeasurement(scheduler: FrameScheduler): {
  snapshot(): FrameMeasurement;
  markMissingInterval(): void;
  stop(): FrameMeasurement;
} {
  let active = true;
  let pending: number | null = null;
  let lastTimestamp: number | null = null;
  let visible = scheduler.isVisible();
  let visibleFrames = 0;
  let hiddenIntervals = visible ? 0 : 1;
  let excludedHiddenCallbacks = 0;
  let excludedMissingIntervals = 0;
  let invalidTimestamps = 0;
  const gaps: number[] = [];

  const syncVisibility = () => {
    const next = scheduler.isVisible();
    if (next !== visible) {
      if (!next) hiddenIntervals += 1;
      lastTimestamp = null;
      visible = next;
    }
  };
  const unsubscribe = scheduler.subscribeVisibilityChange(() => {
    if (active) syncVisibility();
  });
  const snapshot = (): FrameMeasurement => ({
    scope: 'renderer-request-animation-frame',
    nativeResponsivenessVerified: false,
    active,
    visibleFrames,
    visibleFrameGapsMs: summarizeMeasurements(gaps),
    gapsOver50Ms: gaps.filter(gap => gap > FRAME_GAP_DIAGNOSTIC_MS).length,
    hiddenIntervals,
    excludedHiddenCallbacks,
    excludedMissingIntervals,
    invalidTimestamps,
  });
  const frame = (timestamp: number) => {
    // A late callback after cancellation must not alter final evidence or reschedule.
    if (!active) return;
    pending = null;
    syncVisibility();
    if (!visible) {
      excludedHiddenCallbacks += 1;
      lastTimestamp = null;
    } else if (!Number.isFinite(timestamp) || timestamp < 0 ||
      (lastTimestamp !== null && timestamp < lastTimestamp)) {
      invalidTimestamps += 1;
      lastTimestamp = null;
    } else {
      visibleFrames += 1;
      if (lastTimestamp !== null) gaps.push(timestamp - lastTimestamp);
      lastTimestamp = timestamp;
    }
    pending = scheduler.requestFrame(frame);
  };
  pending = scheduler.requestFrame(frame);

  return {
    snapshot,
    markMissingInterval() {
      if (!active) return;
      excludedMissingIntervals += 1;
      lastTimestamp = null;
    },
    stop() {
      if (active) {
        syncVisibility();
        active = false;
        if (pending !== null) scheduler.cancelFrame(pending);
        pending = null;
        unsubscribe();
      }
      return snapshot();
    },
  };
}
