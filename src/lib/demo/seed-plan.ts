import { presetProfile } from "@/lib/profile/presets";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { DEMO_LEARNERS } from "./learners";
import { SAMPLE_LESSON } from "./sample-lesson";

/**
 * What the demo seed creates (PRD P9-02): one teacher, three learners with their own
 * presets, and optionally some progress, so the shared progress page has something to show
 * if the presenter has no time to work through the lesson live. Kept apart from the script
 * so the plan can be tested without a database.
 */

export const DEMO_EMAIL_DOMAIN = "prism-demo.test";

export interface DemoAccount {
  key: string;
  email: string;
  displayName: string;
}

export const DEMO_TEACHER: DemoAccount = {
  key: "teacher",
  email: `demo.teacher@${DEMO_EMAIL_DOMAIN}`,
  displayName: "Mr. Reyes",
};

/** The three learners the PRD names: one card learner, one voice learner, one visual learner. */
const SEEDED = ["maya", "tunde", "sofia"] as const;

export interface DemoLearnerAccount extends DemoAccount {
  profile: RenderProfile;
  /** How many of the lesson's ideas to mark as mastered when progress is seeded. */
  masteredIdeas: number;
}

const MASTERED: Record<(typeof SEEDED)[number], number> = { maya: 5, tunde: 3, sofia: 1 };

export const DEMO_LEARNER_ACCOUNTS: DemoLearnerAccount[] = DEMO_LEARNERS.filter((l) =>
  (SEEDED as readonly string[]).includes(l.id),
).map((l) => ({
  key: l.id,
  email: `demo.${l.id}@${DEMO_EMAIL_DOMAIN}`,
  displayName: l.name,
  profile: presetProfile(l.preset),
  masteredIdeas: MASTERED[l.id as (typeof SEEDED)[number]],
}));

export function isValidDemoPassword(password: string | undefined): password is string {
  return typeof password === "string" && password.length >= 8;
}

export interface SeedEvent {
  id: string;
  user_id: string;
  lesson_id: string;
  graph_version: number;
  type: "quiz_answered";
  concept_id: string;
  quiz_item_id: string;
  correct: true;
  duration_ms: number;
  layout: RenderProfile["layout"];
  occurred_at: string;
}

/**
 * Two right answers in a row on each of the first `learner.masteredIdeas` ideas, which is
 * what mastery means (PRD 5.7), so the database trigger marks them mastered. Events carry
 * the learner's own layout, as real events would.
 */
export function progressEvents(options: {
  userId: string;
  lessonId: string;
  graphVersion: number;
  learner: DemoLearnerAccount;
  start?: Date;
}): SeedEvent[] {
  const { userId, lessonId, graphVersion, learner } = options;
  const start = (options.start ?? new Date()).getTime();
  const concepts = [...SAMPLE_LESSON.concepts].sort((a, b) => a.order - b.order);
  const events: SeedEvent[] = [];
  let tick = 0;
  for (const concept of concepts.slice(0, learner.masteredIdeas)) {
    const items = SAMPLE_LESSON.quizItems.filter((q) => q.conceptId === concept.id).slice(0, 2);
    for (const item of items) {
      events.push({
        // Made from the learner and the position, so running the seed again stores nothing new.
        id: `demo-${userId.slice(0, 8)}-${String(tick).padStart(3, "0")}`,
        user_id: userId,
        lesson_id: lessonId,
        graph_version: graphVersion,
        type: "quiz_answered",
        concept_id: concept.id,
        quiz_item_id: item.id,
        correct: true,
        duration_ms: 8000,
        layout: learner.profile.layout,
        occurred_at: new Date(start + tick * 1000).toISOString(),
      });
      tick++;
    }
  }
  return events;
}
