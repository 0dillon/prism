"use client";

import { useMemo, useState } from "react";
import { announce } from "@/lib/a11y/live-region";
import {
  sortStudents,
  type GridConcept,
  type GridStudent,
  type MasteryStatus,
  type SortDirection,
  type SortKey,
} from "@/lib/classrooms/grid";
import { formatActiveTime } from "@/renderers/shared/lesson";

const STATUS_WORDS: Record<MasteryStatus, string> = {
  mastered: "Mastered",
  in_progress: "In progress",
  not_started: "Not started",
};
// A shape as well as a word, so the state never depends on colour.
const STATUS_MARKS: Record<MasteryStatus, string> = {
  mastered: "✓",
  in_progress: "◐",
  not_started: "○",
};

interface MasteryGridTableProps {
  lessonTitle: string;
  concepts: GridConcept[];
  students: GridStudent[];
}

/**
 * Students down the side, ideas across the top. It is a real table, so a screen reader's
 * table commands read each cell with its student and idea. Each column header is a button
 * that sorts by that column, and the table says how it is sorted.
 */
export function MasteryGridTable({ lessonTitle, concepts, students }: MasteryGridTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "name",
    direction: "ascending",
  });
  const rows = useMemo(
    () => sortStudents(students, sort.key, sort.direction),
    [students, sort.key, sort.direction],
  );

  const labelOf = (key: SortKey) =>
    key === "name"
      ? "student name"
      : key === "mastered"
        ? "ideas mastered"
        : (concepts.find((c) => `concept:${c.id}` === key)?.title ?? "idea");

  const sortBy = (key: SortKey) => {
    // The first press on a progress column puts the furthest along first; names start A to Z.
    const direction: SortDirection =
      sort.key === key
        ? sort.direction === "ascending"
          ? "descending"
          : "ascending"
        : key === "name"
          ? "ascending"
          : "descending";
    setSort({ key, direction });
    announce(`Sorted by ${labelOf(key)}, ${direction}.`);
  };

  const ariaSort = (key: SortKey) => (sort.key === key ? sort.direction : "none");
  const arrow = (key: SortKey) =>
    sort.key === key ? (sort.direction === "ascending" ? " ▲" : " ▼") : "";

  // A function that returns markup, not a component, so it is not recreated as one on every render.
  const sortHeader = (sortKey: SortKey, label: string) => (
    <th
      key={sortKey}
      scope="col"
      aria-sort={ariaSort(sortKey)}
      className="border-line border-b p-2 text-start align-bottom"
    >
      <button
        type="button"
        onClick={() => sortBy(sortKey)}
        className="min-h-11 cursor-pointer text-start font-semibold underline"
      >
        {label}
        <span aria-hidden="true">{arrow(sortKey)}</span>
      </button>
    </th>
  );

  return (
    <div
      role="region"
      aria-label={`${lessonTitle}: mastery by student`}
      // Wide grids scroll sideways; the region is focusable so a keyboard user can scroll it.
      tabIndex={0}
      className="overflow-x-auto"
    >
      <table className="w-full border-collapse text-start">
        <caption className="sr-only">
          Mastery of each idea in {lessonTitle}, by student. Sorted by {labelOf(sort.key)},{" "}
          {sort.direction}.
        </caption>
        <thead>
          <tr>
            {sortHeader("name", "Student")}
            {concepts.map((concept) => sortHeader(`concept:${concept.id}`, concept.title))}
            {sortHeader("mastered", "Mastered")}
            <th scope="col" className="border-line border-b p-2 text-start align-bottom">
              Time spent
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((student) => (
            <tr key={student.studentId} className="border-line border-b align-top">
              <th scope="row" className="p-2 text-start font-semibold">
                {student.name}
              </th>
              {concepts.map((concept) => {
                const cell = student.cells[concept.id];
                const status = cell?.status ?? "not_started";
                return (
                  <td key={concept.id} className="p-2">
                    <span aria-hidden="true">{STATUS_MARKS[status]} </span>
                    {STATUS_WORDS[status]}
                  </td>
                );
              })}
              <td className="p-2">
                {student.mastered} of {student.total}
              </td>
              <td className="p-2">{formatActiveTime(student.activeSeconds * 1000)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
