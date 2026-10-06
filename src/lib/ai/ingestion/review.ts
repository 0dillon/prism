import type {
  Concept,
  KnowledgeGraph,
  QuizItem,
  SourceLocator,
} from "@/lib/schemas/knowledge-graph";
import { normalizeOrder } from "./validate";

/**
 * Pure editing operations for the review screen (PRD CE-2). Each takes a graph and returns
 * a new one; none mutates its input. Order numbers are kept contiguous, quiz items never
 * outlive their concept, and concept ids never change, so learner progress keyed to a
 * concept survives an edit.
 */

export type Direction = "up" | "down";

export type ConceptPatch = Partial<
  Pick<Concept, "title" | "summary" | "body" | "keyTerm" | "definition" | "examples" | "visualHint">
>;

const sorted = (graph: KnowledgeGraph): Concept[] =>
  [...graph.concepts].sort((a, b) => a.order - b.order);

function withConcepts(graph: KnowledgeGraph, concepts: Concept[]): KnowledgeGraph {
  const present = new Set(concepts.map((concept) => concept.sectionId));
  const renumbered = concepts.map((concept, order) => ({ ...concept, order }));
  return normalizeOrder({
    ...graph,
    concepts: renumbered,
    // A section with no concepts left is removed.
    sections: graph.sections.filter((section) => present.has(section.id)),
  });
}

/** Concepts in teaching order. */
export function orderedConcepts(graph: KnowledgeGraph): Concept[] {
  return sorted(graph);
}

/** Ids of concepts the teacher should look at first: flagged as ungrounded or low confidence. */
export function flaggedConceptIds(graph: KnowledgeGraph): string[] {
  return sorted(graph)
    .filter((concept) =>
      concept.flags.some((flag) => flag === "ungrounded" || flag === "low_confidence"),
    )
    .map((concept) => concept.id);
}

export function updateConcept(
  graph: KnowledgeGraph,
  id: string,
  patch: ConceptPatch,
): KnowledgeGraph {
  return {
    ...graph,
    concepts: graph.concepts.map((concept) =>
      concept.id === id ? { ...concept, ...patch } : concept,
    ),
  };
}

export function updateSectionTitle(
  graph: KnowledgeGraph,
  id: string,
  title: string,
): KnowledgeGraph {
  return {
    ...graph,
    sections: graph.sections.map((section) =>
      section.id === id ? { ...section, title } : section,
    ),
  };
}

/** Removes a concept and everything that points at it: its quiz items and prerequisite links. */
export function deleteConcept(graph: KnowledgeGraph, id: string): KnowledgeGraph {
  const remaining = sorted(graph)
    .filter((concept) => concept.id !== id)
    .map((concept) => ({
      ...concept,
      prerequisites: concept.prerequisites.filter((prerequisite) => prerequisite !== id),
    }));
  return withConcepts(
    { ...graph, quizItems: graph.quizItems.filter((item) => item.conceptId !== id) },
    remaining,
  );
}

/**
 * Moves a concept one place earlier or later. If it crosses into another section it
 * joins that section, so the lesson stays organized without a separate "move section" step.
 */
export function moveConcept(
  graph: KnowledgeGraph,
  id: string,
  direction: Direction,
): KnowledgeGraph {
  const concepts = sorted(graph);
  const from = concepts.findIndex((concept) => concept.id === id);
  const to = direction === "up" ? from - 1 : from + 1;
  if (from === -1 || to < 0 || to >= concepts.length) return graph;

  const moving = concepts[from];
  const neighbor = concepts[to];
  const next = [...concepts];
  next[from] = neighbor;
  next[to] = { ...moving, sectionId: neighbor.sectionId };
  return withConcepts(graph, next);
}

/** Whether a concept can move in a direction. */
export function canMove(graph: KnowledgeGraph, id: string, direction: Direction): boolean {
  const concepts = sorted(graph);
  const index = concepts.findIndex((concept) => concept.id === id);
  if (index === -1) return false;
  return direction === "up" ? index > 0 : index < concepts.length - 1;
}

/** Folds a concept into the one before it: text is appended, quiz items and examples carry over. */
export function mergeIntoPrevious(graph: KnowledgeGraph, id: string): KnowledgeGraph {
  const concepts = sorted(graph);
  const index = concepts.findIndex((concept) => concept.id === id);
  if (index <= 0) return graph;

  const absorbed = concepts[index];
  const keeper = concepts[index - 1];
  const merged: Concept = {
    ...keeper,
    body: [keeper.body, absorbed.body].filter(Boolean).join("\n\n"),
    examples: [...new Set([...keeper.examples, ...absorbed.examples])],
    keyTerm: keeper.keyTerm ?? absorbed.keyTerm,
    definition: keeper.definition ?? absorbed.definition,
    flags: [...new Set([...keeper.flags, "edited" as const])],
  };
  const rest = concepts
    .filter((concept) => concept.id !== id)
    .map((concept) => {
      if (concept.id === keeper.id) return merged;
      // Anything that required the absorbed concept now requires the keeper.
      const prerequisites = [
        ...new Set(concept.prerequisites.map((p) => (p === id ? keeper.id : p))),
      ].filter((p) => p !== concept.id);
      return { ...concept, prerequisites };
    });

  return withConcepts(
    {
      ...graph,
      quizItems: graph.quizItems.map((item) =>
        item.conceptId === id ? { ...item, conceptId: keeper.id } : item,
      ),
    },
    rest,
  );
}

/** Adds a blank concept at the end of a section. The teacher fills it in; it has no source excerpt. */
export function addConcept(
  graph: KnowledgeGraph,
  sectionId: string,
  newId: string,
): KnowledgeGraph {
  const concepts = sorted(graph);
  let insertAt = concepts.length;
  for (let i = concepts.length - 1; i >= 0; i--) {
    if (concepts[i].sectionId === sectionId) {
      insertAt = i + 1;
      break;
    }
  }
  const source: SourceLocator = { kind: "offset", start: 0, excerpt: "" };
  const created: Concept = {
    id: newId,
    sectionId,
    order: insertAt,
    title: "New concept",
    summary: "Add a one or two sentence summary.",
    body: "Explain the idea in plain words.",
    examples: [],
    prerequisites: [],
    source,
    flags: ["edited"],
  };
  const next = [...concepts.slice(0, insertAt), created, ...concepts.slice(insertAt)];
  return withConcepts(graph, next);
}

/** The teacher has looked at a flagged concept and is happy with it. */
export function markChecked(graph: KnowledgeGraph, id: string): KnowledgeGraph {
  return {
    ...graph,
    concepts: graph.concepts.map((concept) =>
      concept.id === id
        ? { ...concept, flags: concept.flags.filter((flag) => flag === "edited") }
        : concept,
    ),
    quizItems: graph.quizItems.map((item) =>
      item.conceptId === id
        ? { ...item, flags: item.flags.filter((flag) => flag === "edited") }
        : item,
    ),
  };
}

// Quiz items (P2-13)

export type QuizItemPatch = Partial<
  Pick<
    QuizItem,
    "type" | "prompt" | "options" | "answer" | "acceptable" | "explanation" | "difficulty"
  >
>;

export function updateQuizItem(
  graph: KnowledgeGraph,
  id: string,
  patch: QuizItemPatch,
): KnowledgeGraph {
  return {
    ...graph,
    quizItems: graph.quizItems.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      // Options belong to multiple choice only.
      if (next.type !== "mcq") delete next.options;
      return next;
    }),
  };
}

export function deleteQuizItem(graph: KnowledgeGraph, id: string): KnowledgeGraph {
  return { ...graph, quizItems: graph.quizItems.filter((item) => item.id !== id) };
}

/** Adds a blank multiple choice item to a concept. The teacher edits it before saving. */
export function addQuizItem(
  graph: KnowledgeGraph,
  conceptId: string,
  newId: string,
): KnowledgeGraph {
  const item: QuizItem = {
    id: newId,
    conceptId,
    type: "mcq",
    prompt: "New question",
    options: ["Correct answer", "Wrong answer", "Another wrong answer"],
    answer: "Correct answer",
    acceptable: [],
    explanation: "Explain why this answer is right.",
    difficulty: "recall",
    flags: ["edited"],
  };
  return { ...graph, quizItems: [...graph.quizItems, item] };
}

export function quizItemsFor(graph: KnowledgeGraph, conceptId: string): QuizItem[] {
  return graph.quizItems.filter((item) => item.conceptId === conceptId);
}

/**
 * Marks as "edited" every concept and quiz item whose content differs from the saved
 * version. Run on the server, so the flag is authoritative whatever the client sends.
 */
export function applyEditedFlags(previous: KnowledgeGraph, next: KnowledgeGraph): KnowledgeGraph {
  const conceptKey = (c: Concept) =>
    JSON.stringify([c.title, c.summary, c.body, c.keyTerm, c.definition, c.examples, c.visualHint]);
  const itemKey = (q: QuizItem) =>
    JSON.stringify([
      q.type,
      q.prompt,
      q.options,
      q.answer,
      q.acceptable,
      q.explanation,
      q.difficulty,
    ]);

  const before = new Map(previous.concepts.map((c) => [c.id, conceptKey(c)]));
  const beforeItems = new Map(previous.quizItems.map((q) => [q.id, itemKey(q)]));

  return {
    ...next,
    concepts: next.concepts.map((concept) => {
      const old = before.get(concept.id);
      const changed = old === undefined || old !== conceptKey(concept);
      return changed && !concept.flags.includes("edited")
        ? { ...concept, flags: [...concept.flags, "edited" as const] }
        : concept;
    }),
    quizItems: next.quizItems.map((item) => {
      const old = beforeItems.get(item.id);
      const changed = old === undefined || old !== itemKey(item);
      return changed && !item.flags.includes("edited")
        ? { ...item, flags: [...item.flags, "edited" as const] }
        : item;
    }),
  };
}

/** A short, plain-language description of where a concept came from in the source. */
export function describeLocator(locator: Pick<SourceLocator, "kind" | "start" | "end">): string {
  switch (locator.kind) {
    case "page":
      return `Page ${locator.start}`;
    case "time": {
      const minutes = Math.floor(locator.start / 60);
      const seconds = Math.floor(locator.start % 60);
      return `${minutes}:${String(seconds).padStart(2, "0")} in the recording`;
    }
    case "offset":
      return "Your text";
  }
}
