import { z } from "zod";

/**
 * Learning Event schema (PRD 5.7). Identical in shape across every renderer so
 * progress and engagement are measured the same way everywhere.
 */
export const LearningEventType = z.enum([
  "lesson_started",
  "concept_viewed",
  "concept_variant_requested",
  "quiz_presented",
  "quiz_answered",
  "question_asked",
  "session_paused",
  "session_resumed",
  "lesson_completed",
  "profile_changed",
]);
export type LearningEventType = z.infer<typeof LearningEventType>;

export const LearningEvent = z.object({
  id: z.string(), // client-generated ULID for idempotency
  userId: z.string(),
  lessonId: z.string(),
  graphVersion: z.number().int(),
  type: LearningEventType,
  conceptId: z.string().optional(),
  quizItemId: z.string().optional(),
  correct: z.boolean().optional(), // quiz_answered only
  durationMs: z.number().int().optional(), // active time attributed to this event
  layout: z.enum(["reader", "cards", "conversation", "visual"]), // product analytics only
  occurredAt: z.string().datetime(),
});
export type LearningEvent = z.infer<typeof LearningEvent>;

/** Clients send events in batches (PRD 5.7). The cap bounds one request's size. */
export const MAX_EVENTS_PER_BATCH = 200;
export const LearningEventBatch = z.array(LearningEvent).min(1).max(MAX_EVENTS_PER_BATCH);
export type LearningEventBatch = z.infer<typeof LearningEventBatch>;
