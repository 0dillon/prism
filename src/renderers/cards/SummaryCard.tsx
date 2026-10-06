"use client";

import { Button } from "@/components/Button";
import { countOf, formatActiveTime } from "../shared/lesson";

interface SummaryCardProps {
  totalConcepts: number;
  masteredConcepts: number;
  correctCount: number;
  answeredCount: number;
  bestStreak: number;
  activeMs: number;
  /** Whether the learner has streaks turned on. The count is hidden when they have not. */
  showStreak: boolean;
  onRestart: () => void;
}

/**
 * The card at the end of a lesson (PRD 5.6.1): what was mastered, how long it took and, if
 * the learner wants streaks, their best run. Figures are stated in words, never shown as a
 * score the learner is expected to be graded by. Mastered means two right answers in a row
 * on a concept, the same rule the progress page uses.
 */
export function SummaryCard({
  totalConcepts,
  masteredConcepts,
  correctCount,
  answeredCount,
  bestStreak,
  activeMs,
  showStreak,
  onRestart,
}: SummaryCardProps) {
  const rows: Array<[string, string]> = [
    ["Ideas mastered", `${masteredConcepts} of ${totalConcepts}`],
    [
      "Questions answered right",
      answeredCount === 0 ? "None asked" : `${correctCount} of ${answeredCount}`,
    ],
    ...(showStreak
      ? ([["Best streak", `${countOf(bestStreak, "answer")} in a row`]] as Array<[string, string]>)
      : []),
    ["Time spent", formatActiveTime(activeMs)],
  ];

  return (
    <section
      aria-labelledby="summary-heading"
      data-card-focus=""
      tabIndex={-1}
      className="border-line bg-background flex flex-col gap-5 rounded-xl border p-6 outline-none sm:p-8"
    >
      <h2 id="summary-heading" className="text-3xl font-bold">
        Lesson complete
      </h2>
      <p className="text-xl">
        {masteredConcepts >= totalConcepts && totalConcepts > 0
          ? "You have mastered every idea in this lesson."
          : "You reached the end of the lesson. Ideas that are not mastered yet are worth another look."}
      </p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2">
        {rows.map(([term, value]) => (
          <div key={term} className="border-line col-span-2 grid grid-cols-subgrid border-b py-2">
            <dt className="font-medium">{term}</dt>
            <dd className="text-end font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <Button onClick={onRestart}>Go through it again</Button>
      </div>
    </section>
  );
}
