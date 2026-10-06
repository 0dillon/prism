import type { Concept } from "@/lib/schemas/knowledge-graph";

/**
 * How much of the lesson the reader shows at once (`content.chunkSize`): one idea, one
 * section, or the whole lesson. The session still moves one concept at a time; these
 * helpers say which concepts are on the page for a position, and how far "Next" should go.
 */

export type ChunkSize = "concept" | "section" | "full";

/** The first and last index in `concepts` of the concept's section. */
export function sectionRange(
  concepts: readonly Pick<Concept, "sectionId">[],
  index: number,
): { first: number; last: number } {
  const sectionId = concepts[index]?.sectionId;
  let first = index;
  let last = index;
  concepts.forEach((concept, i) => {
    if (concept.sectionId !== sectionId) return;
    first = Math.min(first, i);
    last = Math.max(last, i);
  });
  return { first, last };
}

/** The concepts on the page when the learner is at `index`. */
export function pageOf<T extends Pick<Concept, "sectionId">>(
  concepts: readonly T[],
  index: number,
  chunk: ChunkSize,
): T[] {
  if (concepts.length === 0 || !concepts[index]) return [];
  if (chunk === "full") return [...concepts];
  if (chunk === "concept") return [concepts[index]];
  const { first, last } = sectionRange(concepts, index);
  return concepts.slice(first, last + 1);
}

/** How many times to press "next" in the session to leave this page. */
export function stepsToLeave(
  concepts: readonly Pick<Concept, "sectionId">[],
  index: number,
  chunk: ChunkSize,
): number {
  if (chunk === "concept") return 1;
  if (chunk === "full") return Math.max(concepts.length - index, 1);
  return sectionRange(concepts, index).last - index + 1;
}

export function isLastPage(
  concepts: readonly Pick<Concept, "sectionId">[],
  index: number,
  chunk: ChunkSize,
): boolean {
  if (chunk === "full") return true;
  if (chunk === "concept") return index >= concepts.length - 1;
  return sectionRange(concepts, index).last >= concepts.length - 1;
}

/** Where "Back" goes, as a concept index, or null when there is nowhere to go back to. */
export function backTarget(
  concepts: readonly Pick<Concept, "sectionId">[],
  index: number,
  chunk: ChunkSize,
): number | null {
  if (chunk === "full") return null;
  if (chunk === "concept") return index > 0 ? index - 1 : null;
  const { first } = sectionRange(concepts, index);
  if (first === 0) return null;
  return sectionRange(concepts, first - 1).first;
}
