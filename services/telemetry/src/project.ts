import { createHash } from 'node:crypto';
import { RunEventSchema, QAResultSchema } from '../../../contracts/index.js';

export class TelemetryError extends Error {
  constructor(readonly code: 'INVALID_RECORD' | 'CONFLICT' | 'UNAVAILABLE' | 'INVALID_CONFIG') {
    super(code); this.name = 'TelemetryError';
  }
}
/** Stable technical join key; never use this to claim anonymity of enumerable IDs. */
export function identityKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export type TelemetryRecord = {
  recordKey: string; kind: 'event' | 'qa'; runKey: string; scenarioKey: string;
  targetApp: string; evidenceKind: 'native' | 'fixture' | 'none'; observedAt: string;
  payloadHash: string; payload: Record<string, unknown>;
};
function finish(kind: TelemetryRecord['kind'], recordId: string, runId: string, scenarioId: string,
  targetApp: string, evidenceKind: TelemetryRecord['evidenceKind'], observedAt: string,
  payload: Record<string, unknown>): TelemetryRecord {
  const record = { recordKey: identityKey(`${kind}:${recordId}`), kind, runKey: identityKey(runId),
    scenarioKey: identityKey(scenarioId), targetApp, evidenceKind, observedAt, payload };
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded) > 8192) throw new TelemetryError('INVALID_RECORD');
  return { ...record, payloadHash: identityKey(encoded) };
}
export function projectEvent(input: unknown): TelemetryRecord {
  const parsed = RunEventSchema.safeParse(input);
  if (!parsed.success) throw new TelemetryError('INVALID_RECORD');
  const e = parsed.data;
  return finish('event', e.eventId, e.runId, e.scenarioId, e.target.appId, e.evidenceKind, e.at, {
    version: e.version, requestKey: e.requestId === null ? null : identityKey(e.requestId),
    adapterKey: identityKey(e.target.adapterVersion), sequence: e.sequence, generation: e.generation,
    monotonicMs: e.monotonicMs, type: e.type, phase: e.phase, mode: e.mode,
    providerKey: identityKey(e.provider), remainingMs: e.remainingMs,
    codeKey: e.code ? identityKey(e.code) : null, evidenceCount: e.evidenceRefs.length,
  });
}
export function projectQA(input: unknown): TelemetryRecord {
  const parsed = QAResultSchema.safeParse(input);
  if (!parsed.success) throw new TelemetryError('INVALID_RECORD');
  const q = parsed.data;
  const names = new Set<string>();
  for (const metric of q.metrics) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(metric.name) || names.has(metric.name)) {
      throw new TelemetryError('INVALID_RECORD');
    }
    names.add(metric.name);
  }
  return finish('qa', q.resultId, q.runId, q.scenarioId, q.target.appId, q.evidenceKind, q.measuredAt, {
    version: q.version, adapterKey: identityKey(q.target.adapterVersion), profileKey: identityKey(q.profileId),
    check: q.check, status: q.status, metrics: q.metrics.map(m => ({ name: m.name, value: m.value, unit: m.unit })),
    evidenceCount: q.evidenceRefs.length, limitationCount: q.limitations.length,
  });
}
