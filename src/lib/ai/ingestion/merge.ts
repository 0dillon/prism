import { monotonicFactory } from "ulid";
import { z } from "zod";
import { logger } from "@/lib/log";
import { Concept, Section } from "@/lib/schemas/knowledge-graph";
import { generateStructured as defaultGenerate } from "../llm";
import { buildMergeConceptsPrompt, MERGE_CONCEPTS_SYSTEM } from "../prompts/merge-concepts";
import type { UsageCallback } from "../usage";
import type { CandidateConcept } from "./concepts";
import { clampText, normalizeForMatch } from "./text";
import { ExtractionError } from "./types";

/**
 * Step 5 of ingestion (PRD 5.1): deduplicate candidates, order them for teaching, group
 * them into sections, assign prerequisites, and assign stable ids.
 *
 * The model proposes; this code decides. Whatever the model returns, the result has
 * unique ids, contiguous order numbers, every real candidate accounted for, and
 * prerequisites that point only to earlier concepts, so cycles cannot occur.
 */

const MAX_PREREQUISITES = 3;
const MAX_OVERVIEW = 600;

export const MergeOutput = z.object({
  title: z.string().min(1),
  overview: z.string().min(1),
  sections: z.array(z.object({ title: z.string().min(1), concepts: z.array(z.string()) })).min(1),
  duplicates: z
    .array(z.object({ keep: z.string(), absorbed: z.array(z.string()).min(1) }))
    .default([]),
  prerequisites: z
    .array(z.object({ concept: z.string(), requires: z.array(z.string()).min(1) }))
    .default([]),
});
export type MergeOutput = z.infer<typeof MergeOutput>;

export interface MergedParts {
  title: string;
  overview: string;
  sections: Section[];
  concepts: Concept[];
}

export type IdFactory = () => string;

/** Time-ordered, unique ids. Monotonic so ids made in the same millisecond still sort. */
export function createIdFactory(): IdFactory {
  const next = monotonicFactory();
  return () => next();
}

const ref = (index: number) => `r${index}`;

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalizeForMatch(value);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

/** Applies the model's proposal to the candidates and enforces every structural rule. */
export function assembleMergedParts(
  candidates: CandidateConcept[],
  proposal: MergeOutput,
  options: { newId?: IdFactory; fallbackTitle?: string } = {},
): MergedParts {
  const newId = options.newId ?? createIdFactory();
  const byRef = new Map(candidates.map((candidate, index) => [ref(index), candidate]));

  // 1. Duplicates: fold absorbed candidates into the one that is kept. No chains.
  const keepers = new Set(proposal.duplicates.map((d) => d.keep).filter((r) => byRef.has(r)));
  const absorbedInto = new Map<string, string>();
  for (const group of proposal.duplicates) {
    if (!byRef.has(group.keep)) continue;
    for (const other of group.absorbed) {
      if (other === group.keep || !byRef.has(other)) continue;
      if (keepers.has(other) || absorbedInto.has(other)) continue;
      absorbedInto.set(other, group.keep);
    }
  }

  // 2. Sections: keep valid, unplaced, non-absorbed refs in the model's order.
  const placed = new Set<string>();
  const sectionPlans: { title: string; refs: string[] }[] = [];
  for (const section of proposal.sections) {
    const refs: string[] = [];
    for (const r of section.concepts) {
      if (!byRef.has(r) || absorbedInto.has(r) || placed.has(r)) continue;
      placed.add(r);
      refs.push(r);
    }
    if (refs.length > 0) sectionPlans.push({ title: section.title.trim(), refs });
  }

  // 3. Nothing is lost: candidates the model forgot go in a final section.
  const forgotten = candidates
    .map((_, index) => ref(index))
    .filter((r) => !placed.has(r) && !absorbedInto.has(r));
  if (forgotten.length > 0) {
    logger.warn("merge proposal left candidates out; appended them", { count: forgotten.length });
    sectionPlans.push({ title: "More ideas", refs: forgotten });
  }
  if (sectionPlans.length === 0) throw new ExtractionError("No concepts could be organized.");

  // 4. Ids and order. Order numbers are contiguous across the whole lesson.
  const sections: Section[] = sectionPlans.map((plan, order) => ({
    id: `s_${newId()}`,
    title: plan.title || `Part ${order + 1}`,
    order,
  }));

  const orderOf = new Map<string, number>();
  const idOf = new Map<string, string>();
  const sectionIdOf = new Map<string, string>();
  let position = 0;
  sectionPlans.forEach((plan, sectionIndex) => {
    for (const r of plan.refs) {
      orderOf.set(r, position++);
      idOf.set(r, `c_${newId()}`);
      sectionIdOf.set(r, sections[sectionIndex].id);
    }
  });

  // An absorbed ref stands for the concept that absorbed it.
  const resolve = (r: string) => absorbedInto.get(r) ?? r;

  // 5. Prerequisites: only existing, earlier concepts, no repeats, a few per concept.
  const prerequisitesOf = new Map<string, string[]>();
  for (const entry of proposal.prerequisites) {
    const target = resolve(entry.concept);
    const targetOrder = orderOf.get(target);
    if (targetOrder === undefined) continue;
    const list = prerequisitesOf.get(target) ?? [];
    for (const required of entry.requires) {
      const requiredRef = resolve(required);
      const requiredOrder = orderOf.get(requiredRef);
      if (requiredOrder === undefined || requiredRef === target) continue;
      if (requiredOrder >= targetOrder) {
        logger.warn("dropped a prerequisite that does not come first", { concept: target });
        continue;
      }
      if (!list.includes(requiredRef) && list.length < MAX_PREREQUISITES) list.push(requiredRef);
    }
    prerequisitesOf.set(target, list);
  }

  // 6. Build concepts, folding in anything the absorbed duplicates had to add.
  const absorbedFor = (keeper: string) =>
    [...absorbedInto.entries()].filter(([, to]) => to === keeper).map(([from]) => byRef.get(from)!);

  const concepts: Concept[] = [...orderOf.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([r, order]) => {
      const primary = byRef.get(r)!;
      const duplicates = absorbedFor(r);
      const all = [primary, ...duplicates];
      const lowConfidence = all.every((c) => c.confidence === "low") || primary.excerptRepaired;
      const flags: Concept["flags"] = lowConfidence ? ["low_confidence"] : [];
      return {
        id: idOf.get(r)!,
        sectionId: sectionIdOf.get(r)!,
        order,
        title: primary.title,
        summary: primary.summary,
        body: primary.body,
        keyTerm: primary.keyTerm ?? duplicates.find((d) => d.keyTerm)?.keyTerm,
        definition: primary.definition ?? duplicates.find((d) => d.definition)?.definition,
        examples: uniqueStrings(all.flatMap((c) => c.examples)),
        prerequisites: (prerequisitesOf.get(r) ?? []).map((required) => idOf.get(required)!),
        visualHint: primary.visualHint ?? duplicates.find((d) => d.visualHint)?.visualHint,
        source: primary.source,
        flags,
      };
    });

  return {
    title: clampText(proposal.title, 120) || options.fallbackTitle || concepts[0].title,
    overview: clampText(proposal.overview, MAX_OVERVIEW),
    sections,
    concepts,
  };
}

type Generate = typeof defaultGenerate;

export interface MergeConceptsOptions {
  candidates: CandidateConcept[];
  lessonTitle?: string;
  onUsage?: UsageCallback;
  newId?: IdFactory;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}

export async function mergeConcepts(options: MergeConceptsOptions): Promise<MergedParts> {
  const { candidates } = options;
  if (candidates.length === 0) {
    throw new ExtractionError("No concepts could be extracted from this file.");
  }

  // One candidate needs no organizing, so skip the model call.
  if (candidates.length === 1) {
    const only = candidates[0];
    return assembleMergedParts(
      candidates,
      {
        title: options.lessonTitle?.trim() || only.title,
        overview: only.summary,
        sections: [{ title: options.lessonTitle?.trim() || only.title, concepts: [ref(0)] }],
        duplicates: [],
        prerequisites: [],
      },
      { newId: options.newId },
    );
  }

  const generate = options.generate ?? defaultGenerate;
  const proposal = await generate({
    schema: MergeOutput,
    system: MERGE_CONCEPTS_SYSTEM,
    prompt: buildMergeConceptsPrompt({ lessonTitle: options.lessonTitle, candidates }),
    tier: "heavy",
    name: "merge-concepts",
    onUsage: options.onUsage,
  });
  return assembleMergedParts(candidates, proposal, {
    newId: options.newId,
    fallbackTitle: options.lessonTitle,
  });
}
