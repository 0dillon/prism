import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import type { GridConcept, GridStudent, MasteryStatus } from "./grid-sort";
export { sortStudents } from "./grid-sort";
export type {
  GridCell,
  GridConcept,
  GridStudent,
  MasteryStatus,
  SortDirection,
  SortKey,
} from "./grid-sort";

/**
 * The teacher's mastery grid (PRD 5.8, P6-06): one row per student, one column per idea in an
 * assigned lesson, each cell saying whether the idea is mastered. It reads only the dashboard
 * views, which return nothing but the caller's own classrooms and carry no layout or profile.
 */

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

export interface HardIdea {
  conceptId: string;
  title: string;
  attempts: number;
  correct: number;
  /** The share of answers that were wrong, from 0 to 1. */
  errorRate: number;
}

/**
 * The ideas this class finds hardest (PRD 5.8, P6-07): highest share of wrong answers first.
 * An idea nobody has answered yet has no error rate, so it is left out rather than ranked.
 * With equal rates, the idea with more answers behind it comes first.
 */
export async function loadHardestIdeas(
  user: UserClient,
  classroomId: string,
  lessonId: string,
): Promise<HardIdea[]> {
  const { data, error } = await user
    .from("v_classroom_concept_difficulty")
    .select("concept_id, concept_title, attempts, correct, error_rate")
    .eq("classroom_id", classroomId)
    .eq("lesson_id", lessonId);
  if (error) {
    logger.error("could not load idea difficulty", { error: error.message });
    throw new ServiceError(500, "read_failed", "We could not load the ideas. Please try again.");
  }
  return rankHardestIdeas(
    (data ?? []).flatMap((row) =>
      row.concept_id && row.error_rate !== null
        ? [
            {
              conceptId: row.concept_id,
              title: row.concept_title ?? row.concept_id,
              attempts: row.attempts ?? 0,
              correct: row.correct ?? 0,
              errorRate: Number(row.error_rate),
            },
          ]
        : [],
    ),
  );
}

export function rankHardestIdeas(ideas: HardIdea[]): HardIdea[] {
  return [...ideas].sort(
    (a, b) =>
      b.errorRate - a.errorRate || b.attempts - a.attempts || a.title.localeCompare(b.title),
  );
}
