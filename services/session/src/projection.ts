import { RunEventSchema, type RunEvent } from '../../../contracts/index.js';
import { MAX_BATCH, MAX_EVENTS, SessionError } from './capabilities.js';

export interface Delivery { cursor: number; event: RunEvent }
export interface EventWindow { cursor: number; events: Delivery[] }
export interface SessionView extends EventWindow {
  streamId: string; serverAt: number; readerExpiresAt: number; oldestCursor: number; gap: boolean;
}
// RunEvent is the single host contract. Evidence references can name local artifacts.
export function projectEvent(input: unknown): RunEvent {
  const parsed = RunEventSchema.safeParse(input);
  if (!parsed.success) throw new SessionError('INVALID_EVENT');
  return { ...parsed.data, evidenceRefs: [] };
}
export function appendBatch(state: EventWindow, batch: Delivery[]): EventWindow {
  if (!Array.isArray(batch) || !batch.length || batch.length > MAX_BATCH) throw new SessionError('INVALID_ARGUMENT');
  let cursor = state.cursor;
  let events = state.events.slice();
  for (const delivery of batch) {
    if (!Number.isSafeInteger(delivery.cursor) || delivery.cursor < 1) throw new SessionError('INVALID_ARGUMENT');
    const event = projectEvent(delivery.event);
    if (delivery.cursor <= cursor) {
      const previous = events.find(e => e.cursor === delivery.cursor);
      if (previous && JSON.stringify(projectEvent(previous.event)) !== JSON.stringify(event)) throw new SessionError('CONFLICT');
      continue; // An acknowledged old delivery can never change state.
    }
    if (delivery.cursor !== cursor + 1) throw new SessionError('SEQUENCE_GAP');
    const last = events.at(-1)?.event;
    if (!last && (event.type !== 'selected' || event.sequence !== 1)) throw new SessionError('INVALID_EVENT');
    if (last?.runId === event.runId) {
      if (event.sequence !== last.sequence + 1 || event.generation < last.generation) throw new SessionError('INVALID_EVENT');
      if (last.type === 'reset-completed') throw new SessionError('INVALID_EVENT');
      if (last.type === 'reset-started' && !['reset-completed', 'failed'].includes(event.type)) throw new SessionError('INVALID_EVENT');
    } else if (last && (last.type !== 'reset-completed' || event.type !== 'selected' || event.sequence !== 1 || event.generation <= last.generation)) {
      throw new SessionError('INVALID_EVENT');
    }
    // Reset immediately discards the prior visitor's event history.
    if (event.type === 'reset-started' || (last && event.runId !== last.runId)) events = [];
    cursor = delivery.cursor;
    events.push({ cursor, event });
    events = events.slice(-MAX_EVENTS);
  }
  return { cursor, events };
}
