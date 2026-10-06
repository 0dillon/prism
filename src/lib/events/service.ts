import { z } from "zod";
import type { UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { LearningEvent, MAX_EVENTS_PER_BATCH } from "@/lib/schemas/events";

/**
 * Receiving learning events (PRD 5.7, P5-02). The client sends events without a user; the
 * user is the signed-in session's, set here, so nobody can write events for someone else.
 * Ids are made by the client, and an id already stored is ignored, so a batch that is sent
 * twice (a lost reply, a retry) stores each event once.
 */

/** An event as a client sends it. The user is never taken from the client. */
export const ClientEvent = LearningEvent.omit({ userId: true }).extend({
  id: z.string().min(1).max(40),
  lessonId: z.uuid(),
  conceptId: z.string().max(100).optional(),
  quizItemId: z.string().max(100).optional(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000)
    .optional(),
  graphVersion: z.number().int().min(0).max(1_000_000),
});
export type ClientEvent = z.infer<typeof ClientEvent>;

export const EventBatchRequest = z.object({
  events: z.array(ClientEvent).min(1, "No events.").max(MAX_EVENTS_PER_BATCH),
});

export interface RecordResult {
  /** Events the server now has: stored now or already stored. */
  received: number;
  /** Events it could not store, such as for a lesson the learner may not use. */
  rejected: number;
}

const toRow = (userId: string, e: ClientEvent) => ({
  id: e.id,
  user_id: userId,
  lesson_id: e.lessonId,
  graph_version: e.graphVersion,
  type: e.type,
  concept_id: e.conceptId ?? null,
  quiz_item_id: e.quizItemId ?? null,
  correct: e.correct ?? null,
  duration_ms: e.durationMs ?? null,
  layout: e.layout,
  occurred_at: e.occurredAt,
});

async function insert(user: UserClient, userId: string, events: readonly ClientEvent[]) {
  return user.from("learning_events").upsert(
    events.map((e) => toRow(userId, e)),
    { onConflict: "id", ignoreDuplicates: true },
  );
}

export async function recordEvents(
  user: UserClient,
  userId: string,
  events: readonly ClientEvent[],
): Promise<RecordResult> {
  const first = await insert(user, userId, events);
  if (!first.error) return { received: events.length, rejected: 0 };

  // One event the learner may not write (a lesson that is not theirs, say) fails the whole
  // batch. Try them one at a time, so the good ones are kept and the bad ones are counted.
  if (events.length === 1) {
    logger.warn("event rejected", { code: first.error.code, type: events[0].type });
    return { received: 0, rejected: 1 };
  }
  let received = 0;
  let rejected = 0;
  for (const event of events) {
    const one = await insert(user, userId, [event]);
    if (one.error) {
      rejected++;
      logger.warn("event rejected", { code: one.error.code, type: event.type });
    } else {
      received++;
    }
  }
  return { received, rejected };
}
