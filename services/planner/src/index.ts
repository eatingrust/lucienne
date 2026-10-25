import { createClaudeTransport } from './claude.js';
import { createFactoryTransport } from './factory/transport.mjs';
import { createFactoryPlanner, createClaudeChatPlanner } from './planner.js';

export { createFactoryPlanner, createClaudeChatPlanner, createPreparedPlanner, PlannerError } from './planner.js';
export { createClaudeTransport, ClaudeTransportError } from './claude.js';
export { createFactoryTransport } from './factory/transport.mjs';
export { createRuntime } from './factory/runtime.mjs';
export { createManagedFactoryPlanner } from './managed-factory.js';
export type { PreparedRecipe } from './planner.js';
export type { StructuredTransport, TransportOptions, TransportResult, StructuredRequest } from './transport.js';

export function createBoundedFactoryPlanner(options: Parameters<typeof createFactoryTransport>[0]) {
  return createFactoryPlanner(createFactoryTransport(options));
}
export function createDirectClaudeChatPlanner(options: Parameters<typeof createClaudeTransport>[0]) {
  return createClaudeChatPlanner(createClaudeTransport(options));
}
