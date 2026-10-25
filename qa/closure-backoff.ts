import type { RunnerScheduler } from './observed-runner.ts';

const delays = [250, 500, 1000, 2000, 5000] as const;

/** Wait only after an unsuccessful closure inspection. This bounds polling
 * frequency, never ownership duration or the number of required inspections.
 * Tests keep their injected scheduler; normal session pollMs is independent. */
export function createClosureBackoff(scheduler?: Pick<RunnerScheduler, 'wait'>): () => Promise<void> {
  let index = 0;
  return async () => {
    const delay = delays[index];
    index = Math.min(index + 1, delays.length - 1);
    if (scheduler) await scheduler.wait(delay);
    else await new Promise<void>(resolve => setTimeout(resolve, delay));
  };
}
