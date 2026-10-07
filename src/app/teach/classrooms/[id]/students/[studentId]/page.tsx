import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ServiceError } from "@/lib/api/http";
import { loadStudentDetail } from "@/lib/classrooms/student";
import { listPendingConsents } from "@/lib/consent/service";
import { createClient } from "@/lib/supabase/server";
import { ProgressBar } from "@/renderers/shared/ProgressBar";
import { countOf, formatActiveTime } from "@/renderers/shared/lesson";
import { RecordConsent } from "./RecordConsent";

export const metadata: Metadata = { title: "Student" };

export const dynamic = "force-dynamic";

export default async function StudentPage({
  params,
}: PageProps<"/teach/classrooms/[id]/students/[studentId]">) {
  const { id, studentId } = await params;
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(studentId).success) notFound();

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) {
    redirect(
      `/sign-in?next=${encodeURIComponent(`/teach/classrooms/${id}/students/${studentId}`)}`,
    );
  }

  let detail;
  let waiting = false;
  try {
    detail = await loadStudentDetail(supabase, id, studentId);
    waiting = (await listPendingConsents(supabase, id)).has(studentId);
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href={`/teach/classrooms/${id}`} className="underline">
            Back to the class
          </Link>
        </p>
        <h1 className="text-3xl font-bold">{detail.name}</h1>
      </div>

      {waiting ? <RecordConsent studentId={studentId} name={detail.name} /> : null}

      <section aria-labelledby="lessons-heading" className="flex flex-col gap-4">
        <h2 id="lessons-heading" className="text-xl font-semibold">
          Lessons
        </h2>
        {detail.lessons.length === 0 ? (
          <p className="text-muted">No lessons are assigned to this class yet.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {detail.lessons.map((lesson) => (
              <li
                key={lesson.lessonId}
                className="border-line flex flex-col gap-2 rounded-lg border p-4"
              >
                <h3 className="text-lg font-semibold">{lesson.title}</h3>
                <ProgressBar
                  value={lesson.total === 0 ? 0 : lesson.mastered / lesson.total}
                  label={`Progress in ${lesson.title}`}
                  text={`${lesson.mastered} of ${countOf(lesson.total, "idea")} mastered`}
                />
                <p className="text-muted text-sm">
                  {lesson.answered === 0
                    ? "No questions answered"
                    : `${lesson.correct} of ${lesson.answered} answers right`}
                  {" · "}
                  {formatActiveTime(lesson.activeSeconds * 1000)} spent
                  {" · "}
                  Last worked: {lesson.lastActive}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="settings-heading" className="flex flex-col gap-3">
        <h2 id="settings-heading" className="text-xl font-semibold">
          How {detail.name} has set up Prism
        </h2>
        {detail.sharedSettings === null ? (
          <p className="text-muted">
            {detail.name} has not shared their settings with teachers. That is their choice, and it
            does not affect their progress.
          </p>
        ) : (
          <>
            <p className="text-muted">
              {detail.name} chose to share these settings. They are preferences, not a diagnosis.
            </p>
            <ul className="list-disc ps-6">
              {detail.sharedSettings.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
