import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { ServiceError } from "@/lib/api/http";
import { loadLessonProgress } from "@/lib/lessons/progress-service";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ProgressBar } from "@/renderers/shared/ProgressBar";
import { countOf, formatActiveTime } from "@/renderers/shared/lesson";

export const metadata: Metadata = { title: "Lesson progress" };

// Always the latest numbers.
export const dynamic = "force-dynamic";

export default async function ProgressPage({ params }: PageProps<"/teach/lessons/[id]/progress">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) redirect(`/sign-in?next=${encodeURIComponent(`/teach/lessons/${id}/progress`)}`);

  let report;
  try {
    report = await loadLessonProgress(supabase, createAdminClient(), auth.user.id, id);
  } catch (error) {
    if (error instanceof ServiceError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-bold">Progress: {report.title}</h1>
      <p className="text-muted">
        Every learner is measured the same way: ideas mastered out of the{" "}
        {countOf(report.totalConcepts, "idea")} in this lesson. An idea is mastered after two right
        answers in a row. This page does not show how anyone chose to view the lesson.
      </p>

      {report.learners.length === 0 ? (
        <p>No one has worked on this lesson yet.</p>
      ) : (
        <table className="w-full border-collapse text-start">
          <caption className="sr-only">Progress of each learner on {report.title}</caption>
          <thead>
            <tr className="border-line border-b">
              <th scope="col" className="py-2 pe-4 text-start">
                Learner
              </th>
              <th scope="col" className="py-2 pe-4 text-start">
                Progress
              </th>
              <th scope="col" className="py-2 pe-4 text-start">
                Questions right
              </th>
              <th scope="col" className="py-2 text-start">
                Time spent
              </th>
            </tr>
          </thead>
          <tbody>
            {report.learners.map((learner) => (
              <tr key={learner.name} className="border-line border-b align-top">
                <th scope="row" className="py-3 pe-4 text-start font-semibold">
                  {learner.name}
                </th>
                <td className="py-3 pe-4">
                  <ProgressBar
                    value={
                      learner.totalConcepts === 0
                        ? 0
                        : learner.masteredConcepts / learner.totalConcepts
                    }
                    label={`${learner.name}, progress`}
                    text={`${learner.masteredConcepts} of ${learner.totalConcepts} mastered`}
                  />
                </td>
                <td className="py-3 pe-4">
                  {learner.answered === 0
                    ? "None answered"
                    : `${learner.correct} of ${learner.answered}`}
                </td>
                <td className="py-3">{formatActiveTime(learner.activeSeconds * 1000)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p>
        <Link href={`/teach/lessons/${id}/review`} className="font-semibold underline">
          Back to the lesson
        </Link>
      </p>
    </div>
  );
}
