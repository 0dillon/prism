import type { ClassroomRow } from "./dashboard";

/**
 * CSV export of the principal's classroom table (PRD P6-14). It is built from the same rows
 * as the table on screen, with the same rounding, so the two always agree. It has no layout
 * and no profile columns, because the rows it is built from have none.
 */

export const CSV_COLUMNS = [
  "Class",
  "Teacher",
  "Grade",
  "Subject",
  "Students",
  "Assigned lessons",
  "Completion (%)",
  "Average mastery (%)",
  "Active learners",
  "Time on task (minutes)",
] as const;

export const percent = (share: number): number => Math.round(share * 100);
export const minutes = (seconds: number): number => Math.round(Math.max(seconds, 0) / 60);

/**
 * Quotes a cell when it needs it. A cell that a spreadsheet would read as a formula (it starts
 * with =, +, - or @, or a tab or return) gets a leading apostrophe, so a class named
 * "=HYPERLINK(...)" is shown as text and never run.
 */
export function csvCell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function classroomsToCsv(rows: ClassroomRow[]): string {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.name,
        row.teacherName,
        row.grade,
        row.subject,
        row.students,
        row.assignedLessons,
        // Blank, as on screen, when nothing is assigned: there is nothing to be complete.
        row.assignedLessons === 0 ? null : percent(row.completion),
        row.assignedLessons === 0 ? null : percent(row.averageMastery),
        row.activeLearners,
        minutes(row.activeSeconds),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  // CRLF line endings are what the CSV standard asks for and what spreadsheets expect.
  return lines.join("\r\n") + "\r\n";
}
