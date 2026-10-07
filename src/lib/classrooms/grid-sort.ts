/**
 * What the mastery grid is made of, and how it is sorted. Nothing here touches the database or
 * the server, so the grid's client component can import it without pulling server code into the
 * browser bundle. The loaders that read the views are in grid.ts.
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
