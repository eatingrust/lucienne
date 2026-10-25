/** Main/server runtime entrypoint: imports Node crypto/TLS and loads pg when configured. */
export { TelemetryQueue } from './queue.js';
export type { TelemetrySink, TelemetryStatus } from './queue.js';
export { createTigerSink, TigerSink, tigerConfig } from './tiger.js';
export type { SQLClient, SQLPool } from './tiger.js';
export { identityKey, projectEvent, projectQA, TelemetryError } from './project.js';
export type { TelemetryRecord } from './project.js';
