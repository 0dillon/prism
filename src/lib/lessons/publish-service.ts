import { ServiceError, type UserClient } from "@/lib/api/http";
import { validateGraph, type ValidationIssue } from "@/lib/ai/ingestion/validate";
import { logger } from "@/lib/log";
import type { Json } from "@/lib/supabase/database.types";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";

/**
 * Publishing and reading published lessons (PRD CE-2, 7.5). Publishing runs as one
 * database function so it is all or nothing; reading relies on row-level security to
 * decide who may see a published lesson.
 */

export interface PublishedLesson {
  version: number;
  warnings: ValidationIssue[];
}

/** Postgres error codes raised by publish_lesson. */
const NOT_FOUND = "P0002";
const NOT_READY = "P0001";

export async function publishLesson(
  user: UserClient,
  userId: string,
  lessonId: string,
): Promise<PublishedLesson> {
  const { data: lesson, error } = await user
    .from("lessons")
    .select("id, owner_id, status, graph")
    .eq("id", lessonId)
    .maybeSingle();
  if (error)
    throw new ServiceError(500, "read_failed", "We could not load the lesson. Please try again.");
  if (!lesson || lesson.owner_id !== userId)
    throw new ServiceError(404, "not_found", "Lesson not found.");

  if (lesson.status === "published") {
    throw new ServiceError(409, "already_published", "This lesson is already published.");
  }
  if (lesson.status !== "needs_review") {
    throw new ServiceError(409, "not_ready", "This lesson is not ready to publish yet.");
  }

  // Never publish a draft that does not validate, whatever state it was saved in.
  const checked = validateGraph(lesson.graph);
  if (!checked.ok) {
    logger.error("draft failed validation at publish", {
      lessonId,
      errors: checked.errors.slice(0, 5),
    });
    throw new ServiceError(
      422,
      "invalid_graph",
      `This lesson has a problem that must be fixed first: ${checked.errors[0].message}`,
    );
  }

  const { data: version, error: rpcError } = await user.rpc("publish_lesson", {
    p_lesson_id: lessonId,
    p_graph: checked.graph as Json,
  });
  if (rpcError) {
    if (rpcError.code === NOT_FOUND) throw new ServiceError(404, "not_found", "Lesson not found.");
    if (rpcError.code === NOT_READY) {
      throw new ServiceError(409, "not_ready", "This lesson is not ready to publish yet.");
    }
    logger.error("publish failed", { lessonId, code: rpcError.code, error: rpcError.message });
    throw new ServiceError(
      500,
      "publish_failed",
      "We could not publish the lesson. Please try again.",
    );
  }
  if (typeof version !== "number") {
    throw new ServiceError(
      500,
      "publish_failed",
      "We could not publish the lesson. Please try again.",
    );
  }

  return { version, warnings: checked.warnings };
}

export interface LearnerLesson {
  lessonId: string;
  title: string;
  graphVersion: number;
  graph: KnowledgeGraph;
}

/**
 * The published graph for a learner. Row-level security limits this to lessons the
 * caller is entitled to; anything else, including a draft, looks like "not found".
 */
export async function getPublishedLesson(
  user: UserClient,
  lessonId: string,
): Promise<LearnerLesson> {
  const { data, error } = await user
    .from("lessons")
    .select("id, title, status, graph, graph_version")
    .eq("id", lessonId)
    .maybeSingle();
  if (error)
    throw new ServiceError(500, "read_failed", "We could not load the lesson. Please try again.");
  if (!data || data.status !== "published")
    throw new ServiceError(404, "not_found", "Lesson not found.");

  const graph = KnowledgeGraph.safeParse(data.graph);
  if (!graph.success) {
    logger.error("published graph is invalid", { lessonId });
    throw new ServiceError(500, "corrupt_graph", "This lesson could not be loaded.");
  }
  return {
    lessonId: data.id,
    title: data.title,
    graphVersion: data.graph_version,
    graph: graph.data,
  };
}
