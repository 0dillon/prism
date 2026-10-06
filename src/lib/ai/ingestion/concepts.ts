import { z } from "zod";
import { mapWithConcurrency } from "@/lib/async";
import { logger } from "@/lib/log";
import { SourceLocator } from "@/lib/schemas/knowledge-graph";
import { generateStructured as defaultGenerate } from "../llm";
import { buildExtractConceptsPrompt, EXTRACT_CONCEPTS_SYSTEM } from "../prompts/extract-concepts";
import type { UsageCallback } from "../usage";
import type { Chunk } from "./chunk";
import { clampText, closestSourcePassage, containsExcerpt, normalizeForMatch } from "./text";
import type { Locator, SourceDocument } from "./types";

/**
 * Step 4 of ingestion (PRD 5.1): extract candidate concepts from each chunk, in
 * parallel with a concurrency limit of 4. Every candidate that leaves this step carries
 * an excerpt that really appears in the source, checked here in code rather than
 * trusted to the prompt.
 */

export const CONCURRENCY_LIMIT = 4;
const MAX_TITLE = 80;
const MAX_SUMMARY = 240;
const MAX_EXCERPT = 1200;
const MAX_CONCEPTS_PER_CHUNK = 12;

/**
 * What the model returns. Length and count limits are enforced after the call, not by the
 * schema: a long title is trimmed instead of costing a retry, and Gemini rejects bounded
 * arrays of objects as too complex.
 */
export const ExtractionOutput = z.object({
  concepts: z.array(
    z.object({
      title: z.string().min(1),
      summary: z.string().min(1),
      body: z.string().min(1),
      keyTerm: z.string().optional(),
      definition: z.string().optional(),
      examples: z.array(z.string()).default([]),
      visualHint: z.string().optional(),
      excerpt: z.string().min(1),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

export const CandidateConcept = z.object({
  chunkId: z.string(),
  title: z.string().min(1).max(MAX_TITLE),
  summary: z.string().min(1).max(MAX_SUMMARY),
  body: z.string().min(1),
  keyTerm: z.string().optional(),
  definition: z.string().optional(),
  examples: z.array(z.string()),
  visualHint: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]),
  /** True when the model's excerpt was not verbatim and was replaced by the source's own wording. */
  excerptRepaired: z.boolean(),
  source: SourceLocator,
});
export type CandidateConcept = z.infer<typeof CandidateConcept>;

type Generate = typeof defaultGenerate;

export interface ExtractConceptsOptions {
  document: SourceDocument;
  chunks: Chunk[];
  lessonTitle?: string;
  concurrency?: number;
  onUsage?: UsageCallback;
  /** Called after each chunk finishes, for progress reporting. */
  onProgress?: (done: number, total: number) => void;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}

const optional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** The locator of the segment that contains the excerpt, or the chunk's first locator. */
function locate(document: SourceDocument, chunk: Chunk, excerpt: string): Locator {
  const needle = normalizeForMatch(excerpt);
  for (const segment of document.segments) {
    if (normalizeForMatch(segment.text).includes(needle)) return segment.locator;
  }
  return chunk.locators[0];
}

/** Turns one chunk's model output into verified candidates. Exported for tests. */
export function verifyCandidates(
  output: ExtractionOutput,
  chunk: Chunk,
  document: SourceDocument,
): CandidateConcept[] {
  const candidates: CandidateConcept[] = [];

  for (const draft of output.concepts.slice(0, MAX_CONCEPTS_PER_CHUNK)) {
    let excerpt = draft.excerpt.trim();
    let repaired = false;

    if (!containsExcerpt(chunk.text, excerpt)) {
      const passage = closestSourcePassage(chunk.text, excerpt);
      if (!passage) {
        logger.warn("dropped concept with an excerpt not found in the source", {
          chunkId: chunk.id,
          title: draft.title.slice(0, 80),
        });
        continue;
      }
      excerpt = passage;
      repaired = true;
    }

    const locator = locate(document, chunk, excerpt);
    candidates.push({
      chunkId: chunk.id,
      title: clampText(draft.title, MAX_TITLE),
      summary: clampText(draft.summary, MAX_SUMMARY),
      body: draft.body.trim(),
      keyTerm: optional(draft.keyTerm),
      definition: optional(draft.definition),
      examples: draft.examples.map((example) => example.trim()).filter(Boolean),
      visualHint: optional(draft.visualHint),
      confidence: draft.confidence,
      excerptRepaired: repaired,
      source: {
        kind: locator.kind,
        start: locator.start,
        end: locator.end,
        excerpt: clampText(excerpt, MAX_EXCERPT),
      },
    });
  }
  return candidates;
}

export async function extractConcepts(
  options: ExtractConceptsOptions,
): Promise<CandidateConcept[]> {
  const { document, chunks, onUsage, onProgress } = options;
  const generate = options.generate ?? defaultGenerate;
  let done = 0;

  const perChunk = await mapWithConcurrency(
    chunks,
    options.concurrency ?? CONCURRENCY_LIMIT,
    async (chunk) => {
      const output = await generate({
        schema: ExtractionOutput,
        system: EXTRACT_CONCEPTS_SYSTEM,
        prompt: buildExtractConceptsPrompt({
          lessonTitle: options.lessonTitle,
          headings: chunk.headings,
          text: chunk.text,
        }),
        tier: "heavy",
        name: "extract-concepts",
        onUsage,
      });
      const candidates = verifyCandidates(output, chunk, document);
      onProgress?.(++done, chunks.length);
      return candidates;
    },
  );

  return perChunk.flat();
}
