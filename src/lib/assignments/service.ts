import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * Giving a published lesson to classrooms (PRD 5.8, P6-05). Enrolled students then reach it
 * through is_entitled; nothing else is copied. Assigning again to a classroom that already
 * has the lesson only changes its due date.
 */

const DueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid date.")
  // Date.parse accepts 31 February and rolls it over, so the date must survive a round trip.
  .refine((v) => {
    const parsed = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
  }, "Choose a valid date.");

export const AssignRequest = z.object({
  lessonId: z.uuid(),
  classroomIds: z.array(z.uuid()).min(1, "Choose at least one class.").max(50),
  /** A calendar date, no time. It means the end of that day. */
  dueDate: DueDate.nullish(),
});
export type AssignInput = z.infer<typeof AssignRequest>;

export const UnassignRequest = z.object({
  lessonId: z.uuid(),
  classroomId: z.uuid(),
});

/** The moment a due date ends: the last second of that calendar day, in UTC. */
export function dueAtFor(dueDate: string | null | undefined): string | null {
  return dueDate ? `${dueDate}T23:59:59.000Z` : null;
}

export async function assignLesson(
  user: UserClient,
  userId: string,
  input: AssignInput,
): Promise<{ assigned: number }> {
  const { data: lesson } = await user
    .from("lessons")
    .select("id, owner_id, status")
    .eq("id", input.lessonId)
    .maybeSingle();
  if (!lesson || lesson.owner_id !== userId) {
    throw new ServiceError(404, "not_found", "Lesson not found.");
  }
  if (lesson.status !== "published") {
    throw new ServiceError(409, "not_published", "Publish the lesson before you assign it.");
  }

  const ids = [...new Set(input.classroomIds)];
  const { data: classrooms, error: classroomError } = await user
    .from("classrooms")
    .select("id")
    .in("id", ids)
    .eq("teacher_id", userId)
    .is("archived_at", null);
  if (classroomError) {
    logger.error("could not check classrooms before assigning", { error: classroomError.message });
    throw new ServiceError(
      500,
      "assign_failed",
      "We could not assign the lesson. Please try again.",
    );
  }
  // A class that is not yours, or does not exist, or is archived, is reported the same way.
  if ((classrooms ?? []).length !== ids.length) {
    throw new ServiceError(404, "not_found", "One of the classes was not found.");
  }

  const dueAt = dueAtFor(input.dueDate);
  const { error } = await user.from("assignments").upsert(
    ids.map((classroomId) => ({
      classroom_id: classroomId,
      lesson_id: input.lessonId,
      due_at: dueAt,
    })),
    { onConflict: "classroom_id,lesson_id" },
  );
  if (error) {
    logger.error("could not assign a lesson", { error: error.message });
    throw new ServiceError(
      500,
      "assign_failed",
      "We could not assign the lesson. Please try again.",
    );
  }
  return { assigned: ids.length };
}

export async function unassignLesson(
  user: UserClient,
  userId: string,
  input: z.infer<typeof UnassignRequest>,
): Promise<void> {
  const { data: classroom } = await user
    .from("classrooms")
    .select("id")
    .eq("id", input.classroomId)
    .eq("teacher_id", userId)
    .maybeSingle();
  if (!classroom) throw new ServiceError(404, "not_found", "Class not found.");
  const { error } = await user
    .from("assignments")
    .delete()
    .eq("classroom_id", input.classroomId)
    .eq("lesson_id", input.lessonId);
  if (error) {
    logger.error("could not remove an assignment", { error: error.message });
    throw new ServiceError(500, "unassign_failed", "We could not remove it. Please try again.");
  }
}

export interface AssignedLesson {
  lessonId: string;
  title: string;
  dueAt: string | null;
}

/** What is assigned to a classroom, soonest due date first. */
export async function listClassroomAssignments(
  user: UserClient,
  classroomId: string,
): Promise<AssignedLesson[]> {
  const { data } = await user
    .from("assignments")
    .select("lesson_id, due_at")
    .eq("classroom_id", classroomId);
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const { data: lessons } = await user
    .from("lessons")
    .select("id, title")
    .in(
      "id",
      rows.map((r) => r.lesson_id),
    );
  const titles = new Map((lessons ?? []).map((l) => [l.id, l.title]));
  return rows
    .map((r) => ({
      lessonId: r.lesson_id,
      title: titles.get(r.lesson_id) || "Untitled lesson",
      dueAt: r.due_at,
    }))
    .sort((a, b) => compareDue(a.dueAt, b.dueAt) || a.title.localeCompare(b.title));
}

/** The classes a lesson is already assigned to, with their due dates. */
export async function listLessonAssignments(
  user: UserClient,
  lessonId: string,
): Promise<{ classroomId: string; dueAt: string | null }[]> {
  const { data } = await user
    .from("assignments")
    .select("classroom_id, due_at")
    .eq("lesson_id", lessonId);
  return (data ?? []).map((r) => ({ classroomId: r.classroom_id, dueAt: r.due_at }));
}

/** Earlier due dates first; lessons with no due date last. */
export function compareDue(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** "Due 14 Oct 2026" from a due timestamp. Uses UTC, because due dates are calendar dates. */
export function formatDue(dueAt: string): string {
  return `Due ${new Date(dueAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })}`;
}
