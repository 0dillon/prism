import { z } from "zod";

/**
 * Knowledge Graph schema (PRD 5.2). Source of truth for extracted lesson content.
 * The graph holds no presentation data: no fonts, layouts, or renderer names.
 */

export const SourceLocator = z.object({
  kind: z.enum(["page", "time", "offset"]),
  start: z.number(), // page number, seconds, or character offset
  end: z.number().optional(),
  excerpt: z.string().max(1200), // verbatim source text supporting the concept
});
export type SourceLocator = z.infer<typeof SourceLocator>;

export const Concept = z.object({
  id: z.string(), // stable, e.g. "c_01HZX..." (ULID)
  sectionId: z.string(),
  order: z.number().int(),
  title: z.string().max(80), // short, one idea
  summary: z.string().max(240), // one or two sentences; used by cards and voice
  body: z.string(), // full explanation in plain Markdown
  keyTerm: z.string().optional(), // the main vocabulary item, if any
  definition: z.string().optional(),
  examples: z.array(z.string()).default([]),
  prerequisites: z.array(z.string()).default([]), // concept ids
  visualHint: z.string().optional(), // description of a helpful diagram or image
  source: SourceLocator,
  flags: z.array(z.enum(["ungrounded", "low_confidence", "edited"])).default([]),
});
export type Concept = z.infer<typeof Concept>;

export const QuizItem = z.object({
  id: z.string(),
  conceptId: z.string(),
  type: z.enum(["mcq", "true_false", "short_answer"]),
  prompt: z.string(),
  options: z.array(z.string()).optional(), // mcq only, 3 to 4 options
  answer: z.string(), // correct option text, "true"/"false", or model answer
  acceptable: z.array(z.string()).default([]), // alternative correct phrasings
  explanation: z.string(), // shown or spoken after answering
  difficulty: z.enum(["recall", "apply"]),
  flags: z.array(z.enum(["ungrounded", "low_confidence", "edited"])).default([]),
});
export type QuizItem = z.infer<typeof QuizItem>;

export const Section = z.object({
  id: z.string(),
  title: z.string(),
  order: z.number().int(),
});
export type Section = z.infer<typeof Section>;

export const KnowledgeGraphBase = z.object({
  schemaVersion: z.literal(1),
  lessonId: z.string(),
  title: z.string(),
  overview: z.string().max(600),
  language: z.string().default("en"),
  sections: z.array(Section),
  concepts: z.array(Concept).min(1),
  quizItems: z.array(QuizItem),
  transcript: z
    .array(
      z.object({
        // present for audio sources
        start: z.number(),
        end: z.number(),
        text: z.string(),
      }),
    )
    .optional(),
});

export interface GraphIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Problems with a single quiz item that the object schema cannot express:
 * an MCQ needs 3 to 4 distinct options with exactly one equal to the answer, and a
 * true/false item must answer "true" or "false".
 */
export function quizItemIssues(item: QuizItem): string[] {
  const issues: string[] = [];
  if (item.type === "mcq") {
    const options = item.options ?? [];
    if (options.length < 3 || options.length > 4) {
      issues.push("a multiple-choice item needs 3 to 4 options");
    }
    if (new Set(options).size !== options.length) {
      issues.push("multiple-choice options must be distinct");
    }
    if (options.filter((option) => option === item.answer).length !== 1) {
      issues.push("exactly one option must equal the answer");
    }
  } else if (item.type === "true_false") {
    if (item.answer !== "true" && item.answer !== "false") {
      issues.push('a true/false item must have the answer "true" or "false"');
    }
  }
  return issues;
}

type GraphLike = Pick<z.infer<typeof KnowledgeGraphBase>, "sections" | "concepts" | "quizItems">;

/** Returns the concept ids that sit on a prerequisite cycle, in discovery order. */
export function findPrerequisiteCycle(concepts: Pick<Concept, "id" | "prerequisites">[]): string[] {
  const edges = new Map(concepts.map((concept) => [concept.id, concept.prerequisites]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue; // dangling ids are reported separately
      if (state.get(next) === "visiting") return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const concept of concepts) {
    if (!state.has(concept.id)) {
      const cycle = visit(concept.id);
      if (cycle) return cycle;
    }
  }
  return [];
}

/**
 * Referential integrity checks (PRD 5.1 step 7): unique ids, every concept in a real
 * section, every quiz item on a real concept, prerequisites that exist and form no
 * cycle, and well-formed quiz answers.
 */
export function graphIntegrityIssues(graph: GraphLike): GraphIssue[] {
  const issues: GraphIssue[] = [];

  const duplicate = (ids: string[], list: "sections" | "concepts" | "quizItems") => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) issues.push({ path: [list, index, "id"], message: `duplicate id "${id}"` });
      seen.add(id);
    });
  };
  duplicate(
    graph.sections.map((section) => section.id),
    "sections",
  );
  duplicate(
    graph.concepts.map((concept) => concept.id),
    "concepts",
  );
  duplicate(
    graph.quizItems.map((item) => item.id),
    "quizItems",
  );

  const sectionIds = new Set(graph.sections.map((section) => section.id));
  const conceptIds = new Set(graph.concepts.map((concept) => concept.id));

  graph.concepts.forEach((concept, index) => {
    if (!sectionIds.has(concept.sectionId)) {
      issues.push({
        path: ["concepts", index, "sectionId"],
        message: `concept "${concept.id}" references missing section "${concept.sectionId}"`,
      });
    }
    concept.prerequisites.forEach((prerequisite, prerequisiteIndex) => {
      const path = ["concepts", index, "prerequisites", prerequisiteIndex];
      if (prerequisite === concept.id) {
        issues.push({ path, message: `concept "${concept.id}" lists itself as a prerequisite` });
      } else if (!conceptIds.has(prerequisite)) {
        issues.push({
          path,
          message: `concept "${concept.id}" has missing prerequisite "${prerequisite}"`,
        });
      }
    });
  });

  graph.quizItems.forEach((item, index) => {
    if (!conceptIds.has(item.conceptId)) {
      issues.push({
        path: ["quizItems", index, "conceptId"],
        message: `quiz item "${item.id}" references missing concept "${item.conceptId}"`,
      });
    }
    for (const message of quizItemIssues(item)) {
      issues.push({ path: ["quizItems", index], message: `quiz item "${item.id}": ${message}` });
    }
  });

  const cycle = findPrerequisiteCycle(graph.concepts);
  if (cycle.length > 0) {
    issues.push({
      path: ["concepts"],
      message: `prerequisites form a cycle: ${cycle.join(" -> ")}`,
    });
  }

  return issues;
}

/** The Knowledge Graph: the PRD 5.2 object plus the integrity checks above. */
export const KnowledgeGraph = KnowledgeGraphBase.superRefine((graph, ctx) => {
  for (const issue of graphIntegrityIssues(graph)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});
export type KnowledgeGraph = z.infer<typeof KnowledgeGraph>;
