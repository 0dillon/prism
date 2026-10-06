import { describe, expect, it } from "vitest";
import { LearningEvent, LearningEventBatch, MAX_EVENTS_PER_BATCH } from "@/lib/schemas/events";

const valid = {
  id: "01HZX0000000000000000000AA",
  userId: "user-1",
  lessonId: "lesson-1",
  graphVersion: 1,
  type: "quiz_answered",
  conceptId: "c_1",
  quizItemId: "q_1",
  correct: true,
  durationMs: 4200,
  layout: "cards",
  occurredAt: "2026-10-06T08:30:00.000Z",
} as const;

describe("LearningEvent", () => {
  it("accepts a valid event", () => {
    expect(LearningEvent.parse(valid)).toEqual(valid);
  });

  it("accepts an event with only the required fields", () => {
    const required = {
      id: valid.id,
      userId: valid.userId,
      lessonId: valid.lessonId,
      graphVersion: valid.graphVersion,
      type: "lesson_started",
      layout: valid.layout,
      occurredAt: valid.occurredAt,
    };
    expect(LearningEvent.safeParse(required).success).toBe(true);
  });

  it.each([
    ["unknown type", { type: "clicked" }],
    ["unknown layout", { layout: "grid" }],
    ["fractional graph version", { graphVersion: 1.5 }],
    ["fractional duration", { durationMs: 10.5 }],
    ["non-boolean correct", { correct: "yes" }],
    ["malformed timestamp", { occurredAt: "yesterday" }],
  ])("rejects %s", (_name, override) => {
    expect(LearningEvent.safeParse({ ...valid, ...override }).success).toBe(false);
  });
});

describe("LearningEventBatch", () => {
  it("accepts a batch within the size limit", () => {
    expect(LearningEventBatch.safeParse([valid, { ...valid, id: "2" }]).success).toBe(true);
  });

  it("rejects an empty batch and an oversized batch", () => {
    expect(LearningEventBatch.safeParse([]).success).toBe(false);
    const oversized = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ({
      ...valid,
      id: String(i),
    }));
    expect(LearningEventBatch.safeParse(oversized).success).toBe(false);
  });
});
