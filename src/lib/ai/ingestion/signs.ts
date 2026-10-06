import { z } from "zod";
import type { Concept } from "@/lib/schemas/knowledge-graph";
import { generateStructured as defaultGenerate } from "../llm";
import { buildMatchSignsPrompt, MATCH_SIGNS_SYSTEM } from "../prompts/match-signs";
import type { UsageCallback } from "../usage";
import { normalizeForMatch } from "./text";

/**
 * Step 8 of ingestion (PRD 5.1): propose sign clips for concept key terms. Exact matches
 * are made in code. The model, on the fast tier, handles only terms with no exact match
 * and may only choose from the gloss list it is given. Every link is unverified.
 */

export interface SignGloss {
  id: string;
  gloss: string;
}

export interface SignLink {
  conceptId: string;
  signClipId: string;
}

export const SignMatchOutput = z.object({
  matches: z.array(z.object({ term: z.string(), gloss: z.string() })),
});

type Generate = typeof defaultGenerate;

export interface TagSignsOptions {
  concepts: Concept[];
  glosses: SignGloss[];
  onUsage?: UsageCallback;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}

export async function tagSigns(options: TagSignsOptions): Promise<SignLink[]> {
  const { glosses } = options;
  const withTerm = options.concepts.filter((c) => c.keyTerm?.trim());
  if (glosses.length === 0 || withTerm.length === 0) return [];

  const links = new Map<string, string>(); // conceptId -> signClipId

  // Exact matches need no model.
  const byGloss = new Map(glosses.map((g) => [normalizeForMatch(g.gloss), g.id]));
  for (const concept of withTerm) {
    const exact = byGloss.get(normalizeForMatch(concept.keyTerm as string));
    if (exact) links.set(concept.id, exact);
  }

  const remaining = withTerm.filter((c) => !links.has(c.id));
  if (remaining.length > 0) {
    const generate = options.generate ?? defaultGenerate;
    const terms = remaining.map((concept, i) => ({
      ref: `t${i}`,
      term: concept.keyTerm as string,
    }));
    const glossRefs = glosses.map((g, i) => ({ ref: `g${i}`, gloss: g.gloss }));

    const output = await generate({
      schema: SignMatchOutput,
      system: MATCH_SIGNS_SYSTEM,
      prompt: buildMatchSignsPrompt({ terms, glosses: glossRefs }),
      tier: "fast",
      name: "match-signs",
      onUsage: options.onUsage,
    });

    const conceptOf = new Map(terms.map((t, i) => [t.ref, remaining[i]]));
    const clipOf = new Map(glossRefs.map((g, i) => [g.ref, glosses[i].id]));
    for (const match of output.matches) {
      const concept = conceptOf.get(match.term);
      const clip = clipOf.get(match.gloss);
      // A reference that was not in the lists is dropped, so nothing can be invented.
      if (!concept || !clip || links.has(concept.id)) continue;
      links.set(concept.id, clip);
    }
  }

  return options.concepts.flatMap((concept) => {
    const signClipId = links.get(concept.id);
    return signClipId ? [{ conceptId: concept.id, signClipId }] : [];
  });
}
