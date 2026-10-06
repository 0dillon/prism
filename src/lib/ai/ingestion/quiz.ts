import { z } from "zod";
import { mapWithConcurrency } from "@/lib/async";
import { logger } from "@/lib/log";
import { Concept, QuizItem, quizItemIssues } from "@/lib/schemas/knowledge-graph";
import { generateStructured as defaultGenerate } from "../llm";
import { buildGenerateQuizPrompt, GENERATE_QUIZ_SYSTEM } from "../prompts/generate-quiz";
import type { UsageCallback } from "../usage";
import { CONCURRENCY_LIMIT } from "./concepts";
import { createIdFactory, type IdFactory } from "./merge";
import { normalizeForMatch } from "./text";

/**
 * Step 6 of ingestion (PRD 5.1): at least 2 quiz items per concept, at least one of them
 * multiple choice. The model writes the questions; this code makes every item
 * well-formed (one correct option, 3 to 4 options, true/false answers) and checks
 * coverage, asking again for concepts that fall short.
 */

export const MIN_ITEMS_PER_CONCEPT = 2;
export const MAX_ITEMS_PER_CONCEPT = 4;
const CONCEPTS_PER_CALL = 4;
const MAX_REPAIR_ROUNDS = 2;

/**
 * No `.max()` on the array: Gemini rejects bounded arrays of objects as too complex.
 * The per-concept cap is applied in code instead.
 */
export const QuizOutput = z.object({
  items: z.array(
    z.object({
      concept: z.string(),
      type: z.enum(["mcq", "true_false", "short_answer"]),
      prompt: z.string().min(1),
      options: z.array(z.string()).optional(),
      answer: z.string().min(1),
      acceptable: z.array(z.string()).default([]),
      explanation: z.string().min(1),
      difficulty: z.enum(["recall", "apply"]),
    }),
  ),
});
export type QuizOutput = z.infer<typeof QuizOutput>;
type Draft = QuizOutput["items"][number];

/** A small deterministic generator, so shuffling is reproducible for a given question. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** Models tend to put the right option first or second. Shuffle so position carries no signal. */
export function shuffleOptions(options: string[], seed: string): string[] {
  const random = seededRandom(seed);
  const result = [...options];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    const key = normalizeForMatch(text);
    if (text && !seen.has(key)) {
      seen.add(key);
      result.push(text);
    }
  }
  return result;
}

/**
 * Turns a model draft into a valid QuizItem, or null if it cannot be made valid.
 * Fixes what is safe to fix: option whitespace and case, a missing correct option,
 * too many options. Anything ambiguous is dropped rather than guessed.
 */
export function normalizeQuizItem(
  draft: Draft,
  conceptId: string,
  newId: IdFactory,
): QuizItem | null {
  const base = {
    id: `q_${newId()}`,
    conceptId,
    type: draft.type,
    prompt: draft.prompt.trim(),
    explanation: draft.explanation.trim(),
    difficulty: draft.difficulty,
    flags: [] as QuizItem["flags"],
  };
  if (!base.prompt || !base.explanation) return null;

  let item: QuizItem;

  if (draft.type === "mcq") {
    let options = cleanList(draft.options ?? []);
    const wanted = normalizeForMatch(draft.answer);
    const matches = options.filter((option) => normalizeForMatch(option) === wanted);

    let answer: string;
    if (matches.length === 1) {
      answer = matches[0];
    } else if (matches.length === 0) {
      // The model named an answer it did not list. Add it as an option.
      answer = draft.answer.trim();
      if (!answer) return null;
      options = [...options, answer];
    } else {
      return null;
    }

    if (options.length > 4) {
      const distractors = options.filter((option) => option !== answer).slice(0, 3);
      options = [answer, ...distractors];
    }
    if (options.length < 3) return null;

    item = {
      ...base,
      options: shuffleOptions(options, `${base.prompt}|${answer}`),
      answer,
      acceptable: [],
    };
  } else if (draft.type === "true_false") {
    const answer = normalizeForMatch(draft.answer);
    if (answer !== "true" && answer !== "false") return null;
    item = { ...base, answer, acceptable: [] };
  } else {
    const answer = draft.answer.trim();
    const acceptable = cleanList(draft.acceptable).filter(
      (phrase) => normalizeForMatch(phrase) !== normalizeForMatch(answer),
    );
    item = { ...base, answer, acceptable };
  }

  const checked = QuizItem.safeParse(item);
  if (!checked.success || quizItemIssues(checked.data).length > 0) return null;
  return checked.data;
}

/** Whether a concept's items meet the minimum: enough items, with at least one multiple choice. */
export function meetsCoverage(items: QuizItem[]): boolean {
  return items.length >= MIN_ITEMS_PER_CONCEPT && items.some((item) => item.type === "mcq");
}

/** Keeps at most four items, taking one of each type in turn for variety, and always keeping a multiple choice item. */
function capItems(items: QuizItem[]): QuizItem[] {
  if (items.length <= MAX_ITEMS_PER_CONCEPT) return items;
  const kept = new Set<QuizItem>();
  const firstMcq = items.find((item) => item.type === "mcq");
  if (firstMcq) kept.add(firstMcq);

  const types = ["true_false", "short_answer", "mcq"] as const;
  let added = true;
  while (kept.size < MAX_ITEMS_PER_CONCEPT && added) {
    added = false;
    for (const type of types) {
      if (kept.size >= MAX_ITEMS_PER_CONCEPT) break;
      const next = items.find((item) => item.type === type && !kept.has(item));
      if (next) {
        kept.add(next);
        added = true;
      }
    }
  }
  return items.filter((item) => kept.has(item));
}

type Generate = typeof defaultGenerate;

export interface GenerateQuizOptions {
  concepts: Concept[];
  onUsage?: UsageCallback;
  onProgress?: (done: number, total: number) => void;
  newId?: IdFactory;
  concurrency?: number;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}

export interface QuizResult {
  items: QuizItem[];
  /** Concepts that still lack 2 items or a multiple choice item after the repair rounds. */
  shortfalls: string[];
}

export async function generateQuizItems(options: GenerateQuizOptions): Promise<QuizResult> {
  const generate = options.generate ?? defaultGenerate;
  const newId = options.newId ?? createIdFactory();
  const byConcept = new Map<string, QuizItem[]>(options.concepts.map((c) => [c.id, []]));

  const askFor = async (concepts: Concept[]) => {
    const batches: Concept[][] = [];
    for (let i = 0; i < concepts.length; i += CONCEPTS_PER_CALL) {
      batches.push(concepts.slice(i, i + CONCEPTS_PER_CALL));
    }
    await mapWithConcurrency(batches, options.concurrency ?? CONCURRENCY_LIMIT, async (batch) => {
      const refs = batch.map((concept, index) => ({ ref: `c${index}`, concept }));
      const output = await generate({
        schema: QuizOutput,
        system: GENERATE_QUIZ_SYSTEM,
        prompt: buildGenerateQuizPrompt({ concepts: refs }),
        tier: "heavy",
        name: "generate-quiz",
        onUsage: options.onUsage,
      });
      const conceptOf = new Map(refs.map(({ ref, concept }) => [ref, concept]));
      for (const draft of output.items) {
        const concept = conceptOf.get(draft.concept);
        if (!concept) continue;
        const item = normalizeQuizItem(draft, concept.id, newId);
        if (!item) {
          logger.warn("dropped a malformed quiz item", { conceptId: concept.id, type: draft.type });
          continue;
        }
        const existing = byConcept.get(concept.id)!;
        const duplicate = existing.some(
          (other) => normalizeForMatch(other.prompt) === normalizeForMatch(item.prompt),
        );
        if (!duplicate) existing.push(item);
      }
      options.onProgress?.(
        options.concepts.filter((c) => meetsCoverage(byConcept.get(c.id)!)).length,
        options.concepts.length,
      );
    });
  };

  await askFor(options.concepts);

  for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
    const lacking = options.concepts.filter((c) => !meetsCoverage(byConcept.get(c.id)!));
    if (lacking.length === 0) break;
    logger.warn("asking again for concepts with too few quiz items", {
      round: round + 1,
      count: lacking.length,
    });
    await askFor(lacking);
  }

  const items: QuizItem[] = [];
  const shortfalls: string[] = [];
  for (const concept of options.concepts) {
    const own = capItems(byConcept.get(concept.id)!);
    if (!meetsCoverage(own)) shortfalls.push(concept.id);
    items.push(...own);
  }
  if (shortfalls.length > 0) {
    logger.warn("some concepts still lack quiz coverage", { count: shortfalls.length });
  }
  return { items, shortfalls };
}
