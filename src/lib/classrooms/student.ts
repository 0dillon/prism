import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { describeProfile } from "@/lib/profile/describe";
import { RenderProfile } from "@/lib/schemas/render-profile";

/**
 * One student as their teacher sees them (PRD 5.8, P6-08): progress and time on each lesson
 * assigned to the class, and when they last worked. Their Render Profile appears only if they
 * chose to share it; the database decides that, and an unshared profile is never fetched.
 */

export interface StudentLesson {
  lessonId: string;
  title: string;
  mastered: number;
  total: number;
  answered: number;
  correct: number;
  activeSeconds: number;
  /** When they last worked on it, in words: Today, Yesterday, a date, or Not started. */
  lastActive: string;
}

export interface StudentDetail {
  name: string;
  lessons: StudentLesson[];
  /** The learner's settings in plain words, or null when they have not shared them. */
  sharedSettings: string[] | null;
}

export async function loadStudentDetail(
  user: UserClient,
  classroomId: string,
  studentId: string,
): Promise<StudentDetail> {
  // Only a student on this teacher's roster can be shown; anyone else is "not found".
  const { data: enrolled } = await user
    .from("enrollments")
    .select("student_id")
    .eq("classroom_id", classroomId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (!enrolled) throw new ServiceError(404, "not_found", "Student not found.");

  const [progress, person, shared] = await Promise.all([
    user
      .from("v_classroom_student_progress")
      .select(
        "lesson_id, mastered_concepts, total_concepts, answered, correct, active_seconds, last_active_at",
      )
      .eq("classroom_id", classroomId)
      .eq("student_id", studentId),
    user.from("users_public").select("display_name").eq("id", studentId).maybeSingle(),
    user.rpc("get_shared_profile", { p_classroom: classroomId, p_student: studentId }),
  ]);
  if (progress.error) {
    logger.error("could not load a student", { error: progress.error.message });
    throw new ServiceError(500, "read_failed", "We could not load this student. Please try again.");
  }

  const now = Date.now();
  const rows = progress.data ?? [];
  const titles = new Map<string, string>();
  if (rows.length > 0) {
    const { data } = await user
      .from("lessons")
      .select("id, title")
      .in(
        "id",
        rows.map((r) => r.lesson_id ?? ""),
      );
    for (const lesson of data ?? []) titles.set(lesson.id, lesson.title);
  }

  const lessons = rows
    .filter((r) => r.lesson_id)
    .map((r) => ({
      lessonId: r.lesson_id!,
      title: titles.get(r.lesson_id!) || "Untitled lesson",
      mastered: r.mastered_concepts ?? 0,
      total: r.total_concepts ?? 0,
      answered: r.answered ?? 0,
      correct: r.correct ?? 0,
      activeSeconds: r.active_seconds ?? 0,
      lastActive: formatLastActive(r.last_active_at, now),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  // Not shared and not allowed both come back as null, so the page cannot tell them apart.
  const parsed = shared.data === null ? null : RenderProfile.safeParse(shared.data);
  return {
    name: person.data?.display_name?.trim() || "This student",
    lessons,
    sharedSettings: parsed?.success ? describeProfile(parsed.data) : null,
  };
}

/** "Today", "Yesterday", or the date, for when someone last worked. Takes the clock as input. */
export function formatLastActive(iso: string | null, now: number): string {
  if (!iso) return "Not started";
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
