import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * The teacher's mastery grid (PRD 5.8, P6-06): one row per student, one column per idea in an
 * assigned lesson, each cell saying whether the idea is mastered. It reads only the dashboard
 * views, which return nothing but the caller's own classrooms and carry no layout or profile.
 */

export type MasteryStatus = "not_started" | "in_progress" | "mastered";

export interface GridCell {
  status: MasteryStatus;
  attempts: number;
}

export interface GridConcept {
  id: string;
  title: string;
}

export interface GridStudent {
  studentId: string;
  name: string;
  cells: Record<string, GridCell>;
  mastered: number;
  total: number;
  answered: number;
  correct: number;
  /** Active time on the lesson, in whole seconds. */
  activeSeconds: number;
}

export interface MasteryGrid {
  concepts: GridConcept[];
  students: GridStudent[];
}

const STATUSES: readonly string[] = ["not_started", "in_progress", "mastered"];
const asStatus = (value: string | null): MasteryStatus =>
  STATUSES.includes(value ?? "") ? (value as MasteryStatus) : "not_started";

export async function loadMasteryGrid(
  user: UserClient,
  classroomId: string,
  lessonId: string,
): Promise<MasteryGrid> {
  const [cells, totals] = await Promise.all([
    user
      .from("v_classroom_concept_mastery")
      .select("student_id, display_name, concept_id, concept_title, order_index, status, attempts")
      .eq("classroom_id", classroomId)
      .eq("lesson_id", lessonId),
    user
      .from("v_classroom_student_progress")
      .select("student_id, mastered_concepts, total_concepts, answered, correct, active_seconds")
      .eq("classroom_id", classroomId)
      .eq("lesson_id", lessonId),
  ]);
  if (cells.error || totals.error) {
    logger.error("could not load the mastery grid", {
      error: (cells.error ?? totals.error)?.message,
    });
    throw new ServiceError(500, "read_failed", "We could not load the grid. Please try again.");
  }

  const concepts = new Map<string, GridConcept & { order: number }>();
  const students = new Map<string, GridStudent>();
  const totalsByStudent = new Map((totals.data ?? []).map((t) => [t.student_id, t]));

  for (const row of cells.data ?? []) {
    if (!row.student_id || !row.concept_id) continue;
    if (!concepts.has(row.concept_id)) {
      concepts.set(row.concept_id, {
        id: row.concept_id,
        title: row.concept_title ?? row.concept_id,
        order: row.order_index ?? 0,
      });
    }
    let student = students.get(row.student_id);
    if (!student) {
      const t = totalsByStudent.get(row.student_id);
      student = {
        studentId: row.student_id,
        name: row.display_name?.trim() ?? "",
        cells: {},
        mastered: t?.mastered_concepts ?? 0,
        total: t?.total_concepts ?? 0,
        answered: t?.answered ?? 0,
        correct: t?.correct ?? 0,
        activeSeconds: t?.active_seconds ?? 0,
      };
      students.set(row.student_id, student);
    }
    student.cells[row.concept_id] = {
      status: asStatus(row.status),
      attempts: row.attempts ?? 0,
    };
  }

  // A student with no name is shown by position, never by id.
  let unnamed = 0;
  const list = [...students.values()].map((s) =>
    s.name ? s : { ...s, name: `Student ${++unnamed}` },
  );
  return {
    concepts: [...concepts.values()]
      .sort((a, b) => a.order - b.order)
      .map(({ id, title }) => ({ id, title })),
    students: list.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export type SortKey = "name" | "mastered" | `concept:${string}`;
export type SortDirection = "ascending" | "descending";

const RANK: Record<MasteryStatus, number> = { not_started: 0, in_progress: 1, mastered: 2 };

/** Sorts students by name, by ideas mastered, or by how far they have got on one idea. */
export function sortStudents(
  students: GridStudent[],
  key: SortKey,
  direction: SortDirection,
): GridStudent[] {
  const sign = direction === "ascending" ? 1 : -1;
  const value = (s: GridStudent): number =>
    key === "mastered"
      ? s.mastered
      : key.startsWith("concept:")
        ? RANK[s.cells[key.slice("concept:".length)]?.status ?? "not_started"]
        : 0;
  return [...students].sort((a, b) => {
    const byKey = key === "name" ? a.name.localeCompare(b.name) : value(a) - value(b);
    // Ties fall back to name so the order is stable and predictable.
    return sign * byKey || a.name.localeCompare(b.name);
  });
}
