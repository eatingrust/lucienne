import type { StructuredTransport } from '../transport.js';
export interface FactoryRuntime {
  readonly execPath: string;
  readonly cwd: string;
  verify(context?: { signal?: AbortSignal }): Promise<boolean>;
  /** Production runtimes confirm all verification probe groups have closed/exited. */
  isQuiescent?(): boolean;
}
export interface FactoryOptions {
  runtime: FactoryRuntime;
  apiKey?: string;
  modelId?: 'claude-opus-5-5';
  timeoutMs?: number;
  onEvidence?: (evidence: Record<string, unknown>) => void;
  onLifecycle?: (event: Record<string, unknown>) => void;
}
export function createFactoryTransport(options: FactoryOptions): StructuredTransport;
