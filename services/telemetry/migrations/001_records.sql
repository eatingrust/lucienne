-- Explicit product migration; apply only to the newly approved product database.
-- This does not run on application startup and does not provision a service.
BEGIN;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
CREATE SCHEMA IF NOT EXISTS lucienne_telemetry;
CREATE TABLE IF NOT EXISTS lucienne_telemetry.records (
  record_key text PRIMARY KEY CHECK (record_key ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('event', 'qa')),
  run_key text NOT NULL CHECK (run_key ~ '^[0-9a-f]{64}$'),
  scenario_key text NOT NULL CHECK (scenario_key ~ '^[0-9a-f]{64}$'),
  target_app text NOT NULL CHECK (target_app IN ('blender', 'krita', 'reaper', 'kdenlive')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('native', 'fixture', 'none')),
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192)
);
CREATE INDEX IF NOT EXISTS records_scenario_evidence ON lucienne_telemetry.records (scenario_key, evidence_kind, observed_at);
CREATE INDEX IF NOT EXISTS records_ingested ON lucienne_telemetry.records (ingested_at);
COMMIT;
