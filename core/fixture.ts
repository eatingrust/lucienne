import type { NativeAdapter, PlannerPort, DesktopPort } from '../contracts/ports.js';
import { validateRequest, type PlannerRequest, type Operation } from '../contracts/index.js';
import type { Selection } from './session.js';

// Test seam only. No app launch, native capability or actual desktop claim.
export function makeFixture(request: PlannerRequest): { selection: Selection; adapter: NativeAdapter; planner: PlannerPort; desktop: DesktopPort } {
  const input = validateRequest(request);
  let operations: Operation[] = [];
  let appliedRequestId = '';
  return {
    selection: { scenarioId: input.scenarioId, source: input.source, target: input.target },
    adapter: {
      target: input.target, evidenceKind: 'fixture', catalog: input.catalog,
      async apply(patch, _request, context) {
        if (!context.isCurrent()) throw new Error('STALE_RESULT');
        operations = structuredClone(patch.operations); appliedRequestId = patch.requestId;
      },
      async readback(context) {
        if (!context.isCurrent()) throw new Error('STALE_RESULT');
        return { requestId: appliedRequestId, targetVisible: true, interactive: true,
          operations: structuredClone(operations), evidenceRefs: ['fixture:readback:1'] };
      },
      async reset() {
        operations = []; appliedRequestId = '';
        return { targetClosed: true, preferencesRestored: true, visitorArtifactsCleared: true, evidenceRefs: ['fixture:reset:1'] };
      },
    },
    planner: {
      provider: 'local-fixture', mode: 'prepared',
      async plan(request, { signal, onProgress }) {
        signal.throwIfAborted(); onProgress();
        const preferences = new Map(request.source.preferences.map(p => [p.key, p.value]));
        request.explicit.forEach(p => preferences.set(p.key, p.value));
        const current = new Map(request.currentOperations.map(op => [op.capabilityId, op.value]));
        return {
          patch: { version: 1, runId: request.runId, requestId: request.requestId, scenarioId: request.scenarioId, target: request.target,
            operations: request.catalog.map(c => ({ capabilityId: c.id,
              value: (c.bindingAction ? request.source.bindings[c.bindingAction] : undefined) ??
                (c.preferenceKey ? preferences.get(c.preferenceKey) : undefined) ?? current.get(c.id) ?? c.values[0] })),
            evidenceRefs: request.evidenceRefs, summary: 'Prepared synthetic lifecycle fixture. No native app was changed.',
            limitations: ['Native behavior and full reset are unverified by this fixture.'] },
          provenance: { provider: 'local-fixture', mode: 'prepared', evidenceRefs: request.evidenceRefs },
        };
      },
    },
    desktop: { async returnToDesktop() { return { desktopVisible: true, evidenceRefs: ['fixture:desktop:1'] }; } },
  };
}
