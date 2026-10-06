import { z } from "zod";
import { clampText } from "../ingestion/text";
import { generateStructured as defaultGenerate } from "../llm";
import { buildRewritePrompt, rewriteSystem, type ReadingLevel } from "../prompts/rewrite-concept";
import type { UsageCallback } from "../usage";
import type { Concept } from "@/lib/schemas/knowledge-graph";

/**
 * Generates a reading-level variant of one concept on the fast tier. Caching, access
 * checks and storage live in the lesson service; this is only the model call.
 */

export const READING_LEVELS = ["plain", "simple"] as const;
export const MAX_VARIANT_SUMMARY = 240;

export const VariantOutput = z.object({
  summary: z.string().min(1),
  body: z.string().min(1),
});

export interface Variant {
  summary: string;
  body: string;
}

type Generate = typeof defaultGenerate;

export async function generateVariant(options: {
  concept: Concept;
  level: ReadingLevel;
  onUsage?: UsageCallback;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}): Promise<Variant> {
  const generate = options.generate ?? defaultGenerate;
  const output = await generate({
    schema: VariantOutput,
    system: rewriteSystem(options.level),
    prompt: buildRewritePrompt(options.concept),
    tier: "fast",
    name: `rewrite-${options.level}`,
    onUsage: options.onUsage,
  });
  return {
    summary: clampText(output.summary, MAX_VARIANT_SUMMARY),
    body: output.body.trim(),
  };
}
