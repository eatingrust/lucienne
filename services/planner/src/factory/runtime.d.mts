import type { FactoryRuntime } from './transport.mjs';
export function createRuntime(options: { binary: string }): Promise<FactoryRuntime & {
  root: string;
  policy: string;
  evidence: Record<string, unknown>;
  isQuiescent(): boolean;
  diagnostics(): Record<string, unknown>;
  dispose(): boolean;
}>;
