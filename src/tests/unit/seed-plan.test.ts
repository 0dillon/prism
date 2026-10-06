import { describe, expect, it } from "vitest";
import {
  DEMO_EMAIL_DOMAIN,
  DEMO_LEARNER_ACCOUNTS,
  DEMO_TEACHER,
  isValidDemoPassword,
  progressEvents,
} from "@/lib/demo/seed-plan";
import { SAMPLE_LESSON } from "@/lib/demo/sample-lesson";
import { LearningEvent } from "@/lib/schemas/events";

const USER = "99999999-9999-4999-8999-999999999999";
const LESSON = "11111111-1111-4111-8111-111111111111";

describe("the demo accounts", () => {
  it("has one teacher and the three learners the PRD names, on their presets", () => {
    expect(DEMO_TEACHER.email).toBe(`demo.teacher@${DEMO_EMAIL_DOMAIN}`);
    expect(
      DEMO_LEARNER_ACCOUNTS.map((l) => [l.displayName, l.profile.preset, l.profile.layout]),
    ).toEqual([
      ["Maya", "hyper_focus", "cards"],
      ["Tunde", "voice_native", "conversation"],
      ["Sofia", "visual_sign", "visual"],
    ]);
  });

  it("uses a reserved test domain, so no real person's address is ever used", () => {
    expect(DEMO_EMAIL_DOMAIN.endsWith(".test")).toBe(true);
    for (const account of [DEMO_TEACHER, ...DEMO_LEARNER_ACCOUNTS]) {
      expect(account.email.endsWith(`@${DEMO_EMAIL_DOMAIN}`)).toBe(true);
    }
  });

  it("has distinct emails", () => {
    const emails = [DEMO_TEACHER, ...DEMO_LEARNER_ACCOUNTS].map((a) => a.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("names no condition", () => {
    expect(JSON.stringify([DEMO_TEACHER, ...DEMO_LEARNER_ACCOUNTS])).not.toMatch(
      /adhd|dyslex|autis|blind|deaf|disabilit/i,
    );
  });

  it("holds no password: it must come from the environment", () => {
    expect(JSON.stringify([DEMO_TEACHER, ...DEMO_LEARNER_ACCOUNTS])).not.toMatch(/password/i);
    expect(isValidDemoPassword(undefined)).toBe(false);
    expect(isValidDemoPassword("short")).toBe(false);
    expect(isValidDemoPassword("long enough")).toBe(true);
  });
});

describe("progressEvents", () => {
  const learner = (key: string) => DEMO_LEARNER_ACCOUNTS.find((l) => l.key === key)!;
  const make = (key: string) =>
    progressEvents({
      userId: USER,
      lessonId: LESSON,
      graphVersion: 1,
      learner: learner(key),
      start: new Date("2026-10-06T10:00:00Z"),
    });

  it("gives two right answers on each idea a learner has mastered", () => {
    const events = make("tunde");
    expect(events).toHaveLength(6);
    const byConcept = new Map<string, number>();
    for (const e of events) byConcept.set(e.concept_id, (byConcept.get(e.concept_id) ?? 0) + 1);
    expect([...byConcept.values()]).toEqual([2, 2, 2]);
    expect(events.every((e) => e.correct)).toBe(true);
  });

  it("puts the three learners on different points of the same scale", () => {
    const counts = DEMO_LEARNER_ACCOUNTS.map((l) => [l.key, make(l.key).length / 2]);
    expect(counts).toEqual([
      ["maya", 5],
      ["tunde", 3],
      ["sofia", 1],
    ]);
    expect(Math.max(...counts.map((c) => c[1] as number))).toBeLessThanOrEqual(
      SAMPLE_LESSON.concepts.length,
    );
  });

  it("uses real questions from the lesson, each on its own idea", () => {
    for (const e of make("maya")) {
      const item = SAMPLE_LESSON.quizItems.find((q) => q.id === e.quiz_item_id)!;
      expect(item.conceptId).toBe(e.concept_id);
    }
    const ids = make("maya").map((e) => e.quiz_item_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds events the schema accepts, with the learner's own layout and unique ids in time order", () => {
    const events = make("sofia");
    for (const e of events) {
      const parsed = LearningEvent.safeParse({
        id: e.id,
        userId: e.user_id,
        lessonId: e.lesson_id,
        graphVersion: e.graph_version,
        type: e.type,
        conceptId: e.concept_id,
        quizItemId: e.quiz_item_id,
        correct: e.correct,
        durationMs: e.duration_ms,
        layout: e.layout,
        occurredAt: e.occurred_at,
      });
      expect(parsed.success).toBe(true);
      expect(e.layout).toBe("visual");
    }
    const times = events.map((e) => Date.parse(e.occurred_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("is the same events for the same inputs, so a re-run adds nothing", () => {
    expect(make("maya")).toEqual(make("maya"));
    expect(make("maya")[0].id).toMatch(/^demo-99999999-000$/);
    expect(make("maya")[0].id.length).toBeLessThanOrEqual(40);
  });
});
