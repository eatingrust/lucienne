import { rootCertificates, checkServerIdentity } from 'node:tls';
import { TelemetryError, type TelemetryRecord } from './project.js';
import type { TelemetrySink } from './queue.js';

export interface SQLClient {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
  release(error?: boolean): void;
}
export interface SQLPool { connect(): Promise<SQLClient>; end(): Promise<void>; }
export function tigerConfig(value: string) {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash ||
      !/^([a-z0-9-]+\.)+(?:timescale|tigerdata)\.com$/.test(url.hostname) ||
      !['.tsdb.cloud.timescale.com', '.tsdb.cloud.tigerdata.com'].some(s => url.hostname.endsWith(s))) throw new Error();
    const user = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (![user, password, database].every(s => s.length > 0 && !/[\x00-\x1f]/.test(s)) || database.includes('/')) throw new Error();
    for (const [key, option] of url.searchParams) {
      if (!({ sslmode: ['verify-full'], sslrootcert: ['system'], connect_timeout: ['5'] } as Record<string, string[]>)[key]?.includes(option)) throw new Error();
    }
    const port = Number(url.port || 5432);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return { host: url.hostname, port, user, password, database,
      ssl: { rejectUnauthorized: true, ca: [...rootCertificates], servername: url.hostname, checkServerIdentity },
      connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000, lock_timeout: 1000,
      idle_in_transaction_session_timeout: 10_000, application_name: 'lucienne-telemetry',
      options: '-c timezone=UTC -c search_path=pg_catalog', client_encoding: 'UTF8', max: 1, idleTimeoutMillis: 10_000, allowExitOnIdle: true };
  } catch { throw new TelemetryError('INVALID_CONFIG'); }
}
const INSERT = `INSERT INTO lucienne_telemetry.records
  (record_key, kind, run_key, scenario_key, target_app, evidence_kind, observed_at, payload_hash, payload)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
  ON CONFLICT (record_key) DO UPDATE SET payload_hash = EXCLUDED.payload_hash
  WHERE lucienne_telemetry.records.payload_hash = EXCLUDED.payload_hash RETURNING record_key`;
/** Each batch has one transaction, serializes retention, and is safe to retry after a lost ACK. */
export class TigerSink implements TelemetrySink {
  constructor(private readonly pool: SQLPool) {}
  async write(records: readonly TelemetryRecord[]): Promise<void> {
    if (records.length < 1 || records.length > 32) throw new TelemetryError('INVALID_RECORD');
    let client: SQLClient | undefined;
    let destroy = false;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL transaction_timeout = '15s'");
      await client.query('SELECT pg_advisory_xact_lock(1819632500)');
      for (const r of records) {
        const result = await client.query(INSERT, [r.recordKey, r.kind, r.runKey, r.scenarioKey,
          r.targetApp, r.evidenceKind, r.observedAt, r.payloadHash, JSON.stringify(r.payload)]);
        if (result.rowCount !== 1) throw new TelemetryError('CONFLICT');
      }
      await client.query("DELETE FROM lucienne_telemetry.records WHERE ingested_at < now() - interval '24 hours'");
      await client.query(`DELETE FROM lucienne_telemetry.records WHERE record_key IN (
        SELECT record_key FROM lucienne_telemetry.records ORDER BY ingested_at DESC, record_key DESC OFFSET 10000)`);
      await client.query('COMMIT');
    } catch (error) {
      destroy = true;
      if (client) { try { await client.query('ROLLBACK'); } catch { /* discard connection; completion uncertain */ } }
      throw error instanceof TelemetryError ? error : new TelemetryError('UNAVAILABLE');
    } finally { client?.release(destroy); }
  }
  close(): Promise<void> { return this.pool.end(); }
}
/** Server/main-process only. Instantiation starts no connection; first flush connects. */
export async function createTigerSink(databaseURL: string): Promise<TigerSink> {
  const config = tigerConfig(databaseURL);
  const { Pool } = await import('pg');
  const pool = new Pool(config);
  // pg emits idle socket errors: deliberately do not forward raw provider text/URLs.
  pool.on('error', () => {});
  return new TigerSink(pool);
}
