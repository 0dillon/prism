import { percent } from "@/lib/admin/csv";
import type { ClassroomRow } from "@/lib/admin/dashboard";
import { countOf, formatActiveTime } from "@/renderers/shared/lesson";

/**
 * One row per class: how far its students have got, and how active they were in the chosen
 * dates. Progress is on the same scale for every class (ideas mastered out of ideas assigned)
 * and says nothing about how anyone chose to view a lesson.
 */
export function ClassroomTable({ rows, rangeLabel }: { rows: ClassroomRow[]; rangeLabel: string }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted">
        No classes match. Change or clear the filters, or ask teachers to create classes.
      </p>
    );
  }
  const students = rows.reduce((sum, r) => sum + r.students, 0);
  const active = rows.reduce((sum, r) => sum + r.activeLearners, 0);
  const seconds = rows.reduce((sum, r) => sum + r.activeSeconds, 0);

  return (
    <div className="flex flex-col gap-3">
      <p>
        {rows.length} {rows.length === 1 ? "class" : "classes"} shown, with{" "}
        {countOf(students, "student")}. {countOf(active, "student")} {active === 1 ? "was" : "were"}{" "}
        active from {rangeLabel}, spending {formatActiveTime(seconds * 1000)} in all.
      </p>
      <div role="region" aria-label="Classes" tabIndex={0} className="overflow-x-auto">
        <table className="w-full border-collapse text-start">
          <caption className="sr-only">
            Each class with its teacher, completion, average mastery, active learners and time on
            task, for activity from {rangeLabel}
          </caption>
          <thead>
            <tr>
              {[
                "Class",
                "Teacher",
                "Grade",
                "Subject",
                "Students",
                "Completion",
                "Average mastery",
                "Active learners",
                "Time on task",
              ].map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="border-line border-b p-2 text-start align-bottom"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.classroomId} className="border-line border-b align-top">
                <th scope="row" className="p-2 text-start font-semibold">
                  {row.name}
                </th>
                <td className="p-2">{row.teacherName}</td>
                <td className="p-2">{row.grade ?? "–"}</td>
                <td className="p-2">{row.subject ?? "–"}</td>
                <td className="p-2">{row.students}</td>
                <td className="p-2">
                  {row.assignedLessons === 0 ? "–" : `${percent(row.completion)}%`}
                </td>
                <td className="p-2">
                  {row.assignedLessons === 0 ? "–" : `${percent(row.averageMastery)}%`}
                </td>
                <td className="p-2">
                  {row.activeLearners} of {row.students}
                </td>
                <td className="p-2">{formatActiveTime(row.activeSeconds * 1000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
