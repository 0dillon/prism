import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDue } from "@/lib/assignments/service";
import { loadConsent } from "@/lib/consent/service";
import { loadLearnerHome, progressFraction } from "@/lib/lessons/home-service";
import { loadSharing } from "@/lib/profile/sharing";
import { createClient } from "@/lib/supabase/server";
import { ProgressBar } from "@/renderers/shared/ProgressBar";
import { countOf } from "@/renderers/shared/lesson";
import { ConsentPending } from "./ConsentPending";
import { JoinClassForm } from "./JoinClassForm";
import { ShareSettingsToggle } from "./ShareSettingsToggle";

export const metadata: Metadata = { title: "My lessons" };

// Progress changes as the learner works, so this is never cached or shared.
export const dynamic = "force-dynamic";

const STATUS_WORDS = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
} as const;

export default async function LearnerHomePage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in?next=%2Flearn");

  const [lessons, sharing, consent] = await Promise.all([
    loadLearnerHome(supabase),
    loadSharing(supabase, data.user.id),
    loadConsent(supabase, data.user.id),
  ]);

  // A learner under 13 whose parent or guardian has not agreed yet sees only this.
  if (consent.status === "pending") {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
        <h1 className="text-3xl font-bold">My lessons</h1>
        <ConsentPending requested={consent.requested} />
        <p>
          <Link href="/account" className="underline">
            Your data and privacy
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-bold">My lessons</h1>
      {lessons.length === 0 ? (
        <p className="text-muted">
          There are no lessons for you yet. When a teacher shares one, it will appear here.
        </p>
      ) : (
        <section aria-labelledby="assigned-heading" className="flex flex-col gap-4">
          <h2 id="assigned-heading" className="text-xl font-semibold">
            Assigned
          </h2>
          <ul className="flex flex-col gap-4">
            {lessons.map((lesson) => (
              <li
                key={lesson.lessonId}
                className="border-line flex flex-col gap-3 rounded-lg border p-4"
              >
                <h3 className="text-xl font-semibold">
                  <Link href={`/learn/${lesson.lessonId}`} className="underline">
                    {lesson.title}
                  </Link>
                </h3>
                <ProgressBar
                  value={progressFraction(lesson)}
                  label={`Progress in ${lesson.title}`}
                  text={`${lesson.masteredConcepts} of ${countOf(lesson.totalConcepts, "idea")} mastered`}
                />
                <p className="text-muted text-sm">
                  {STATUS_WORDS[lesson.status]}
                  {lesson.dueAt ? ` · ${formatDue(lesson.dueAt)}` : ""}
                  {lesson.overdue ? " · Overdue" : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <JoinClassForm />
      <ShareSettingsToggle initial={sharing} />
      <p>
        <Link href="/account" className="underline">
          Your data and privacy
        </Link>
      </p>
    </div>
  );
}
