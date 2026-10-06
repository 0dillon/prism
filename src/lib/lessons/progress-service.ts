import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * Progress on one lesson across the learners who have worked on it (PRD 5.8, P5-06), for the
 * lesson's owner. Every learner is measured the same way, by ideas mastered over ideas in
 * the lesson, whichever layout they used. The layout is deliberately not read here: it can
 * reveal how a learner needs to see content, and progress does not depend on it.
 *
 * The owner is checked as the signed-in user. Reading other people's records then uses the
 * server's own access, and only after that check has passed.
 */

/** Active time per event counts for at most this long, which leaves out time left idle (PRD 5.7). */
export const MAX_EVENT_ACTIVE_MS = 60_000;

export interface LearnerProgress {
  /** A name to show. Learners with none are shown by position, never by id. */
  name: string;
  masteredConcepts: number;
  totalConcepts: number;
  /** Questions answered, and how many were right. */
  answered: number;
  correct: number;
  /** Active time in whole seconds. */
  activeSeconds: number;
}

export interface LessonProgressReport {
  title: string;
  totalConcepts: number;
  learners: LearnerProgress[];
}

export async function loadLessonProgress(
  user: UserClient,
  admin: UserClient,
  userId: string,
  lessonId: string,
): Promise<LessonProgressReport> {
  const { data: lesson } = await user
    .from("lessons")
    .select("id, owner_id, title")
    .eq("id", lessonId)
    .maybeSingle();
  // A lesson that does not exist and one that belongs to someone else look the same.
  if (!lesson || lesson.owner_id !== userId) {
    throw new ServiceError(404, "not_found", "Lesson not found.");
  }

  const [concepts, mastery, events] = await Promise.all([
    admin.from("concepts").select("id").eq("lesson_id", lessonId).eq("retired", false),
    admin
      .from("concept_mastery")
      .select("user_id, concept_id, status, attempts, correct_count")
      .eq("lesson_id", lessonId),
    admin.from("learning_events").select("user_id, duration_ms").eq("lesson_id", lessonId),
  ]);
  for (const [what, result] of [
    ["concepts", concepts],
    ["mastery", mastery],
    ["events", events],
  ] as const) {
    if (result.error) {
      logger.error("could not load lesson progress", { what, error: result.error.message });
      throw new ServiceError(
        500,
        "read_failed",
        "We could not load the progress. Please try again.",
      );
    }
  }

  const current = new Set((concepts.data ?? []).map((c) => c.id));
  const learnerIds = new Set<string>([
    ...(mastery.data ?? []).map((m) => m.user_id),
    ...(events.data ?? []).map((e) => e.user_id),
  ]);

  const names = new Map<string, string>();
  if (learnerIds.size > 0) {
    const { data } = await admin
      .from("users_public")
      .select("id, display_name")
      .in("id", [...learnerIds]);
    for (const row of data ?? []) {
      if (row.display_name.trim()) names.set(row.id, row.display_name.trim());
    }
  }

  const learners: LearnerProgress[] = [...learnerIds].map((id) => {
    // Only ideas still in the lesson count, so progress stays between 0 and 100%.
    const mine = (mastery.data ?? []).filter((m) => m.user_id === id && current.has(m.concept_id));
    const active = (events.data ?? [])
      .filter((e) => e.user_id === id)
      .reduce((sum, e) => sum + Math.min(e.duration_ms ?? 0, MAX_EVENT_ACTIVE_MS), 0);
    return {
      name: names.get(id) ?? "",
      masteredConcepts: mine.filter((m) => m.status === "mastered").length,
      totalConcepts: current.size,
      answered: mine.reduce((sum, m) => sum + m.attempts, 0),
      correct: mine.reduce((sum, m) => sum + m.correct_count, 0),
      activeSeconds: Math.round(active / 1000),
    };
  });

  // Learners with no name are numbered after the named ones, so nobody is shown by an id.
  const named = learners.filter((l) => l.name).sort((a, b) => a.name.localeCompare(b.name));
  const unnamed = learners
    .filter((l) => !l.name)
    .map((l, i) => ({ ...l, name: `Learner ${i + 1}` }));
  return { title: lesson.title, totalConcepts: current.size, learners: [...named, ...unnamed] };
}
