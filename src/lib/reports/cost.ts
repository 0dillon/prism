/**
 * The cost report (PRD 6.2, P8-06): ingestion cost per lesson, from the usage each ingestion
 * job records, compared with the budget target of at most 0.50 USD per source. Pure, so it can be
 * tested without a database; scripts/report-cost.ts reads the jobs and prints the result.
 *
 * Learner session cost (variants, tutoring, intents) is not recorded per lesson yet, so the
 * report covers ingestion only and says so.
 */

export const INGESTION_TARGET_USD = 0.5;

export interface JobUsage {
  lessonId: string;
  title: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface LessonCost {
  lessonId: string;
  title: string;
  /** Ingestion runs for this lesson, retries included. */
  runs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  overTarget: boolean;
}

export interface CostSummary {
  lessons: LessonCost[];
  totalUsd: number;
  /** Mean cost per lesson, or 0 with no lessons. */
  averageUsd: number;
  overTarget: number;
}

/** Adds up every job per lesson, most expensive first. Retries count towards the lesson's cost. */
export function summarizeCost(jobs: JobUsage[]): CostSummary {
  const byLesson = new Map<string, LessonCost>();
  for (const job of jobs) {
    const lesson = byLesson.get(job.lessonId) ?? {
      lessonId: job.lessonId,
      title: job.title,
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      overTarget: false,
    };
    lesson.runs += 1;
    lesson.tokensIn += job.tokensIn;
    lesson.tokensOut += job.tokensOut;
    lesson.costUsd += job.costUsd;
    byLesson.set(job.lessonId, lesson);
  }
  const lessons = [...byLesson.values()]
    .map((l) => ({ ...l, overTarget: l.costUsd > INGESTION_TARGET_USD }))
    .sort((a, b) => b.costUsd - a.costUsd || a.title.localeCompare(b.title));
  const totalUsd = lessons.reduce((sum, l) => sum + l.costUsd, 0);
  return {
    lessons,
    totalUsd,
    averageUsd: lessons.length === 0 ? 0 : totalUsd / lessons.length,
    overTarget: lessons.filter((l) => l.overTarget).length,
  };
}
