import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ServiceError } from "@/lib/api/http";
import { formatDue, listClassroomAssignments } from "@/lib/assignments/service";
import { getClassroom } from "@/lib/classrooms/service";
import { loadHardestIdeas, loadMasteryGrid } from "@/lib/classrooms/grid";
import { loadRoster } from "@/lib/classrooms/students";
import { createClient } from "@/lib/supabase/server";
import { countOf } from "@/renderers/shared/lesson";
import { AddStudents } from "./AddStudents";
import { AssignedLessons } from "./AssignedLessons";
import { ClassroomSettings } from "./ClassroomSettings";
import { HardestIdeas } from "./HardestIdeas";
import { MasteryGridTable } from "./MasteryGridTable";

export const metadata: Metadata = { title: "Class" };

export const dynamic = "force-dynamic";

export default async function ClassroomPage({
  params,
  searchParams,
}: PageProps<"/teach/classrooms/[id]">) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect(`/sign-in?next=${encodeURIComponent(`/teach/classrooms/${id}`)}`);

  let classroom;
  try {
    classroom = await getClassroom(supabase, data.user.id, id);
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) notFound();
    throw error;
  }

  const [roster, assigned] = await Promise.all([
    loadRoster(supabase, classroom.id),
    listClassroomAssignments(supabase, classroom.id),
  ]);

  const requested = (await searchParams).lesson;
  const selected = assigned.find((a) => a.lessonId === requested) ?? assigned[0];
  const [grid, hardest] = selected
    ? await Promise.all([
        loadMasteryGrid(supabase, classroom.id, selected.lessonId),
        loadHardestIdeas(supabase, classroom.id, selected.lessonId),
      ])
    : [null, []];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href="/teach/classrooms" className="underline">
            All classes
          </Link>
        </p>
        <h1 className="text-3xl font-bold">{classroom.name}</h1>
        <p className="text-muted">
          {[
            classroom.grade && `Grade ${classroom.grade}`,
            classroom.subject,
            countOf(classroom.students, "student"),
          ]
            .filter(Boolean)
            .join(" · ")}
          {classroom.archived ? " · Archived" : ""}
        </p>
      </div>
      <section aria-labelledby="progress-heading" className="flex flex-col gap-4">
        <h2 id="progress-heading" className="text-xl font-semibold">
          Progress
        </h2>
        {!selected || !grid ? (
          <p className="text-muted">
            Assign a lesson to see how each student is getting on. Every student is measured the
            same way: ideas mastered out of the ideas in the lesson.
          </p>
        ) : (
          <>
            {assigned.length > 1 ? (
              <nav aria-label="Lessons in this class">
                <ul className="flex flex-wrap gap-2">
                  {assigned.map((a) => (
                    <li key={a.lessonId}>
                      <Link
                        href={`/teach/classrooms/${classroom.id}?lesson=${a.lessonId}`}
                        aria-current={a.lessonId === selected.lessonId ? "page" : undefined}
                        className={`inline-flex min-h-11 items-center rounded-md border px-3 ${
                          a.lessonId === selected.lessonId
                            ? "bg-accent text-accent-foreground border-transparent"
                            : "border-line"
                        }`}
                      >
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
            {grid.students.length === 0 ? (
              <p className="text-muted">No students have joined this class yet.</p>
            ) : (
              <MasteryGridTable
                classroomId={classroom.id}
                lessonTitle={selected.title}
                concepts={grid.concepts}
                students={grid.students}
              />
            )}
          </>
        )}
      </section>

      {selected && grid ? (
        <section aria-labelledby="hardest-heading" className="flex flex-col gap-3">
          <h2 id="hardest-heading" className="text-xl font-semibold">
            Hardest ideas in {selected.title}
          </h2>
          <HardestIdeas lessonId={selected.lessonId} ideas={hardest} />
        </section>
      ) : null}

      <AddStudents
        classroomId={classroom.id}
        joinCode={classroom.joinCode}
        archived={classroom.archived}
      />

      <section aria-labelledby="roster-heading" className="flex flex-col gap-3">
        <h2 id="roster-heading" className="text-xl font-semibold">
          Students
        </h2>
        {roster.students.length === 0 ? (
          <p className="text-muted">No students have joined yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {roster.students.map((student) => (
              <li key={student.studentId}>
                <Link
                  href={`/teach/classrooms/${classroom.id}/students/${student.studentId}`}
                  className="underline"
                >
                  {student.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {roster.pending > 0 ? (
          <p className="text-muted">
            {countOf(roster.pending, "address")} waiting for the student to sign up.
          </p>
        ) : null}
      </section>

      <AssignedLessons
        classroomId={classroom.id}
        items={assigned.map((a) => ({
          lessonId: a.lessonId,
          title: a.title,
          dueLabel: a.dueAt ? formatDue(a.dueAt) : null,
        }))}
      />

      <ClassroomSettings classroom={classroom} />
    </div>
  );
}
