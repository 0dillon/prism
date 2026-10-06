import { ulid } from "ulid";
import type { LearningEvent } from "@/lib/schemas/events";

/**
 * Learning events as renderers and the session raise them (PRD 5.7). This is the first
 * part of the event pipeline: `track` builds a complete event with its own id and time
 * and holds it in a queue. Batching, saving on the device and sending to the server come
 * with task P5-01, behind this same `track` call.
 */

/** An event as it is queued. The server adds the user from the signed-in session. */
export type QueuedEvent = Omit<LearningEvent, "userId">;

export type TrackInput = Omit<QueuedEvent, "id" | "occurredAt">;

let queue: QueuedEvent[] = [];
const listeners = new Set<(event: QueuedEvent) => void>();

export function track(input: TrackInput, now: () => Date = () => new Date()): QueuedEvent {
  const event: QueuedEvent = { ...input, id: ulid(), occurredAt: now().toISOString() };
  queue.push(event);
  for (const listener of listeners) listener(event);
  return event;
}

/** Events waiting to be sent, oldest first. */
export function pendingEvents(): readonly QueuedEvent[] {
  return queue;
}

export function subscribeToEvents(listener: (event: QueuedEvent) => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Empties the queue. For tests, and for the sender once events are safely delivered. */
export function clearEvents(): void {
  queue = [];
}
