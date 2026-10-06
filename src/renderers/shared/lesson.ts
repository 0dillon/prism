import type { Concept, KnowledgeGraph, QuizItem, Section } from "@/lib/schemas/knowledge-graph";

/**
 * Small helpers every renderer needs to read the lesson the same way. The session stores a
 * position as an index into the concepts in teaching order, so renderers must use the same
 * order the session does.
 */

export function orderedConcepts(graph: Pick<KnowledgeGraph, "concepts">): Concept[] {
  return [...graph.concepts].sort((a, b) => a.order - b.order);
}

export function sectionOf(
  graph: Pick<KnowledgeGraph, "sections">,
  concept: Pick<Concept, "sectionId">,
): Section | undefined {
  return graph.sections.find((section) => section.id === concept.sectionId);
}

export function activeQuizItem(
  graph: Pick<KnowledgeGraph, "quizItems">,
  itemId: string | null,
): QuizItem | undefined {
  return itemId ? graph.quizItems.find((item) => item.id === itemId) : undefined;
}

/** Whole-lesson progress from 0 to 1: ideas seen over ideas in the lesson. */
export function lessonProgress(
  session: { phase: string; seenConceptIds: readonly string[] },
  totalConcepts: number,
): number {
  if (totalConcepts <= 0) return 0;
  if (session.phase === "complete") return 1;
  return Math.min(session.seenConceptIds.length / totalConcepts, 1);
}

/** "Less than a minute", "1 minute", "7 minutes", "1 hour 5 minutes". For the summary card. */
export function formatActiveTime(ms: number): string {
  const totalMinutes = Math.round(Math.max(ms, 0) / 60_000);
  if (totalMinutes < 1) return "Less than a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (hours === 0) return plural(minutes, "minute");
  return minutes === 0
    ? plural(hours, "hour")
    : `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
}

/** "1 idea" or "6 ideas". */
export function countOf(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
