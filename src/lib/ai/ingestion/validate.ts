import {
  KnowledgeGraph,
  type KnowledgeGraph as KnowledgeGraphType,
} from "@/lib/schemas/knowledge-graph";
import { MIN_ITEMS_PER_CONCEPT } from "./quiz";

/**
 * Step 7 of ingestion (PRD 5.1): validate the draft graph.
 *
 * Errors mean the graph is invalid and cannot be saved. They come from the
 * KnowledgeGraph schema: shape and limits, plus referential integrity (unique ids,
 * quiz items on real concepts, real sections, no prerequisite cycles, well-formed
 * answers). Warnings are things a teacher should look at but that do not break the
 * graph, such as a concept with too few quiz items.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; graph: KnowledgeGraphType; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] };

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>(
    (text, part) =>
      typeof part === "number"
        ? `${text}[${part}]`
        : text
          ? `${text}.${String(part)}`
          : String(part),
    "",
  );
}

/** Problems that do not invalidate the graph but deserve a teacher's attention. */
export function graphWarnings(graph: KnowledgeGraphType): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];

  const sectionsWithConcepts = new Set(graph.concepts.map((concept) => concept.sectionId));
  graph.sections.forEach((section, index) => {
    if (!sectionsWithConcepts.has(section.id)) {
      warnings.push({
        path: `sections[${index}]`,
        message: `section "${section.title}" has no concepts`,
      });
    }
  });

  const orders = graph.concepts.map((concept) => concept.order).sort((a, b) => a - b);
  if (orders.some((order, index) => order !== index)) {
    warnings.push({
      path: "concepts",
      message: "concept order has gaps or repeats; it should be 0 to n-1 (use normalizeOrder)",
    });
  }

  graph.concepts.forEach((concept, index) => {
    const items = graph.quizItems.filter((item) => item.conceptId === concept.id);
    if (items.length < MIN_ITEMS_PER_CONCEPT) {
      warnings.push({
        path: `concepts[${index}]`,
        message: `concept "${concept.title}" has ${items.length} quiz item(s); at least ${MIN_ITEMS_PER_CONCEPT} are expected`,
      });
    }
    if (items.length > 0 && !items.some((item) => item.type === "mcq")) {
      warnings.push({
        path: `concepts[${index}]`,
        message: `concept "${concept.title}" has no multiple choice quiz item`,
      });
    }
    if (!concept.source.excerpt.trim()) {
      warnings.push({
        path: `concepts[${index}].source.excerpt`,
        message: `concept "${concept.title}" has no source excerpt`,
      });
    }
  });

  return warnings;
}

export function validateGraph(input: unknown): ValidationResult {
  const parsed = KnowledgeGraph.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
      warnings: [],
    };
  }
  return { ok: true, graph: parsed.data, warnings: graphWarnings(parsed.data) };
}

/** Renumbers sections and concepts 0 to n-1 in their current order. Use after a delete or reorder. */
export function normalizeOrder(graph: KnowledgeGraphType): KnowledgeGraphType {
  const byOrder = <T extends { order: number }>(items: T[]) =>
    [...items].sort((a, b) => a.order - b.order).map((item, index) => ({ ...item, order: index }));
  return { ...graph, sections: byOrder(graph.sections), concepts: byOrder(graph.concepts) };
}
