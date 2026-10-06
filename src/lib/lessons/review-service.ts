import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { applyEditedFlags } from "@/lib/ai/ingestion/review";
import { normalizeOrder, validateGraph, type ValidationIssue } from "@/lib/ai/ingestion/validate";
import { logger } from "@/lib/log";
import type { Json } from "@/lib/supabase/database.types";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";

/**
 * Saving a teacher's review edits (PRD CE-2). The server is the authority on what a
 * teacher may change: it checks the graph, restores what a teacher cannot edit, and
 * recomputes the "edited" flags, whatever the client sent.
 */

/** A graph larger than this is not a lesson. It also bounds the work done per save. */
export const MAX_GRAPH_BYTES = 2 * 1024 * 1024;

export const SaveGraphInput = z.object({
  graph: z.unknown(),
  /** The lesson's updated_at when the editor loaded it. Detects edits made elsewhere. */
  expectedUpdatedAt: z.string().min(1, "Missing the version you are editing."),
});
export type SaveGraphInput = z.infer<typeof SaveGraphInput>;

export interface SavedGraph {
  graph: KnowledgeGraph;
  warnings: ValidationIssue[];
  updatedAt: string;
}

const ATTENTION_FLAGS = new Set(["ungrounded", "low_confidence"]);

/**
 * Restores what review must not change and limits flags to what the server decides:
 * a concept's source is fixed once extracted; attention flags can be cleared by a
 * teacher but never added; "edited" is computed by comparing with the saved version.
 */
function reconcile(previous: KnowledgeGraph, incoming: KnowledgeGraph): KnowledgeGraph {
  const concepts = new Map(previous.concepts.map((c) => [c.id, c]));
  const items = new Map(previous.quizItems.map((q) => [q.id, q]));

  const keepAttention = <T extends string>(was: T[] | undefined, now: T[]): T[] =>
    now.filter((flag) =>
      ATTENTION_FLAGS.has(flag) ? Boolean(was?.includes(flag)) : flag === "edited",
    );

  return {
    ...incoming,
    lessonId: previous.lessonId,
    language: previous.language,
    transcript: previous.transcript,
    concepts: incoming.concepts.map((concept) => {
      const old = concepts.get(concept.id);
      return {
        ...concept,
        source: old ? old.source : concept.source,
        flags: keepAttention(old?.flags, concept.flags),
      };
    }),
    quizItems: incoming.quizItems.map((item) => ({
      ...item,
      flags: keepAttention(items.get(item.id)?.flags, item.flags),
    })),
  };
}

export async function saveReviewedGraph(
  user: UserClient,
  userId: string,
  lessonId: string,
  input: SaveGraphInput,
): Promise<SavedGraph> {
  if (JSON.stringify(input.graph ?? null).length > MAX_GRAPH_BYTES) {
    throw new ServiceError(413, "too_large", "This lesson is too large to save.");
  }

  const { data: lesson, error } = await user
    .from("lessons")
    .select("id, owner_id, status, graph, updated_at")
    .eq("id", lessonId)
    .maybeSingle();
  if (error)
    throw new ServiceError(500, "read_failed", "We could not load the lesson. Please try again.");
  if (!lesson || lesson.owner_id !== userId)
    throw new ServiceError(404, "not_found", "Lesson not found.");

  if (lesson.status !== "needs_review") {
    throw new ServiceError(
      409,
      "not_editable",
      lesson.status === "published"
        ? "This lesson is published. Editing a published lesson is not available yet."
        : "This lesson is not ready for review yet.",
    );
  }
  if (lesson.updated_at !== input.expectedUpdatedAt) {
    throw new ServiceError(
      409,
      "conflict",
      "This lesson was changed somewhere else. Reload the page to see the latest version.",
    );
  }

  const previous = KnowledgeGraph.safeParse(lesson.graph);
  if (!previous.success) {
    logger.error("stored graph is invalid", { lessonId });
    throw new ServiceError(500, "corrupt_graph", "This lesson's draft could not be read.");
  }

  const checked = validateGraph(input.graph);
  if (!checked.ok) {
    const first = checked.errors[0];
    throw new ServiceError(
      422,
      "invalid_graph",
      `${first.path ? `${first.path}: ` : ""}${first.message}`,
    );
  }

  const reconciled = reconcile(previous.data, normalizeOrder(checked.graph));
  const flagged = applyEditedFlags(previous.data, reconciled);
  const final = validateGraph(flagged);
  if (!final.ok) {
    throw new ServiceError(422, "invalid_graph", final.errors[0].message);
  }

  // The update only applies if nobody saved in between.
  const { data: saved, error: saveError } = await user
    .from("lessons")
    .update({ graph: final.graph as Json, title: final.graph.title })
    .eq("id", lessonId)
    .eq("updated_at", input.expectedUpdatedAt)
    .select("updated_at");
  if (saveError) {
    logger.error("could not save graph", { lessonId, error: saveError.message });
    throw new ServiceError(500, "save_failed", "We could not save your changes. Please try again.");
  }
  if (!saved || saved.length === 0) {
    throw new ServiceError(
      409,
      "conflict",
      "This lesson was changed somewhere else. Reload the page to see the latest version.",
    );
  }

  return { graph: final.graph, warnings: final.warnings, updatedAt: saved[0].updated_at };
}
