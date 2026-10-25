import type { PlannerPort } from '../../../contracts/ports.js';
import { validateRequest } from '../../../contracts/index.js';
import { createFactoryPlanner, PlannerError } from './planner.js';
import { createFactoryTransport } from './factory/transport.mjs';
import type { FactoryOptions, FactoryRuntime } from './factory/transport.mjs';
import { createRuntime } from './factory/runtime.mjs';
import type { StructuredTransport } from './transport.js';

export interface ManagedFactoryOptions extends Omit<FactoryOptions, 'runtime'> {
  /** Trusted host configuration; never supplied by a model or visitor patch. */
  binary: string;
}
export interface ManagedFactoryRuntime extends FactoryRuntime {
  isQuiescent(): boolean;
  dispose(): boolean;
}
/** Trusted host/test seams. A factory must clean up its own failed construction. */
export interface ManagedFactoryDependencies {
  runtimeFactory?: (options: { binary: string }) => Promise<ManagedFactoryRuntime>;
  transportFactory?: (options: FactoryOptions) => StructuredTransport;
}
const cancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw new PlannerError('PLANNER_CANCELLED');
};

/** One private runtime per request; no visitor shares another request's scratch. */
export function createManagedFactoryPlanner(options: ManagedFactoryOptions, dependencies: ManagedFactoryDependencies = {}): PlannerPort {
  const { binary, apiKey, modelId, timeoutMs, onEvidence, onLifecycle } = options;
  const runtimeFactory = dependencies.runtimeFactory ?? createRuntime;
  const transportFactory = dependencies.transportFactory ?? createFactoryTransport;
  const publish = (evidence: Record<string, unknown>) => { try { onEvidence?.(evidence); } catch {} };
  return {
    provider: 'factory', mode: 'live',
    async plan(request, context) {
      cancelled(context.signal);
      let selected;
      try { selected = validateRequest(request); } catch { throw new PlannerError('PLANNER_REQUEST_INVALID'); }
      let runtime: ManagedFactoryRuntime;
      try { runtime = await runtimeFactory({ binary }); }
      catch (error) {
        cancelled(context.signal);
        const code = error instanceof Error && /^FACTORY_[A-Z_]{1,70}$/.test(error.message)
          ? error.message : 'FACTORY_RUNTIME_FAILED';
        throw new PlannerError(code);
      }
      let preflightQuiescent = true;
      let workerStarted = false;
      let processExited = false;
      let groupEmpty: boolean | null = null;
      try {
        cancelled(context.signal);
        const transport = transportFactory({ runtime, apiKey, modelId, timeoutMs,
          onLifecycle(event) {
            if (event.phase === 'worker-spawned') workerStarted = true;
            try { onLifecycle?.(event); } catch {}
          },
          onEvidence(evidence) {
            if (typeof evidence.preflightQuiescent === 'boolean') preflightQuiescent = evidence.preflightQuiescent;
            workerStarted ||= evidence.workerStarted === true;
            if (typeof evidence.workerStarted === 'boolean') {
              processExited = evidence.processExited === true;
              groupEmpty = typeof evidence.groupEmpty === 'boolean' ? evidence.groupEmpty : null;
            }
            publish(evidence);
          },
        });
        return await createFactoryPlanner(transport).plan(selected, context);
      } finally {
        // Never race a detached writer or a merely requested abort with directory removal.
        let probesQuiescent = true;
        try { probesQuiescent = runtime.isQuiescent() === true; }
        catch { probesQuiescent = false; }
        if (!preflightQuiescent || !probesQuiescent || (workerStarted && (!processExited || groupEmpty !== true))) {
          publish({ stage: 'managed-runtime-retained', preflightQuiescent, probesQuiescent, workerStarted, processExited, groupEmpty, runtimeRetained: true });
          throw new PlannerError('FACTORY_CLEANUP_INCOMPLETE');
        }
        let disposed = false;
        try { disposed = runtime.dispose() === true; } catch {}
        publish({ stage: 'managed-runtime-disposed', runtimeDisposed: disposed });
        if (!disposed) throw new PlannerError('FACTORY_CLEANUP_INCOMPLETE');
        cancelled(context.signal);
      }
    },
  };
}
