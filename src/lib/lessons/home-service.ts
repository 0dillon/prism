import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * The learner's home (PRD CE-10, P5-05): the lessons they can open, each with how far they
 * have got. Progress is mastered ideas over ideas in the lesson as it is now (PRD 5.7), so a
 * lesson that gains or loses an idea changes the denominator and not the learner's record.
 * Everything is read as the learner, so row-level security decides which lessons appear.
 */

export interface LessonProgress {
  lessonId: string;
  title: string;
  totalConcepts: number;
  masteredConcepts: number;
  /** Ideas the learner has been asked about at least once. */
  startedConcepts: number;
  status: "not_started" | "in_progress" | "complete";
}

export function progressFraction(p: Pick<LessonProgress, "masteredConcepts" | "totalConcepts">) {
  return p.totalConcepts === 0 ? 0 : Math.min(p.masteredConcepts / p.totalConcepts, 1);
}

export async function loadLearnerHome(user: UserClient): Promise<LessonProgress[]> {
  const lessons = await user
    .from("lessons")
    .select("id, title, status")
    .eq("status", "published")
    .order("created_at", { ascending: false });
  if (lessons.error) fail("lessons", lessons.error.message);
  const rows = lessons.data ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((l) => l.id);
  const [concepts, mastery] = await Promise.all([
    user.from("concepts").select("lesson_id, id").in("lesson_id", ids),
    user.from("concept_mastery").select("lesson_id, concept_id, status").in("lesson_id", ids),
  ]);
  if (concepts.error) fail("concepts", concepts.error.message);
  if (mastery.error) fail("mastery", mastery.error.message);

  const conceptsOf = new Map<string, Set<string>>();
  for (const c of concepts.data ?? []) {
    if (!conceptsOf.has(c.lesson_id)) conceptsOf.set(c.lesson_id, new Set());
    conceptsOf.get(c.lesson_id)!.add(c.id);
  }

  return rows.map((lesson) => {
    const current = conceptsOf.get(lesson.id) ?? new Set<string>();
    // Only ideas still in the lesson count, so an old record cannot push progress past 100%.
    const mine = (mastery.data ?? []).filter(
      (m) => m.lesson_id === lesson.id && current.has(m.concept_id),
    );
    const mastered = mine.filter((m) => m.status === "mastered").length;
    const started = mine.length;
    return {
      lessonId: lesson.id,
      title: lesson.title,
      totalConcepts: current.size,
      masteredConcepts: mastered,
      startedConcepts: started,
      status:
        current.size > 0 && mastered >= current.size
          ? "complete"
          : started > 0
            ? "in_progress"
            : "not_started",
    };
  });
}

function fail(what: string, message: string): never {
  logger.error("could not load the learner home", { what, error: message });
  throw new ServiceError(500, "read_failed", "We could not load your lessons. Please try again.");
}
