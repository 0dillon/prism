import { ServiceError, type UserClient } from "@/lib/api/http";
import { SAMPLE_LESSON, SAMPLE_LESSON_ID } from "@/lib/demo/sample-lesson";
import { getPublishedLesson } from "@/lib/lessons/publish-service";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { z } from "zod";

/**
 * Which lesson a tutor request is about, and whether the caller may use it. A real lesson
 * is read through the caller's own session, so row-level security decides access. The
 * demo lesson is public and fixed, so it needs no account, but callers of it are limited
 * by address instead of by user.
 */

export interface TutorLesson {
  graph: KnowledgeGraph;
  /** True for the public demo lesson. */
  isDemo: boolean;
}

export function isDemoLesson(lessonId: string): boolean {
  return lessonId === SAMPLE_LESSON_ID;
}

export async function loadTutorLesson(
  lessonId: string,
  user: UserClient | null,
): Promise<TutorLesson> {
  if (isDemoLesson(lessonId)) return { graph: SAMPLE_LESSON, isDemo: true };
  if (!user) throw new ServiceError(401, "unauthorized", "Sign in to continue.");
  if (!z.uuid().safeParse(lessonId).success) {
    throw new ServiceError(404, "not_found", "Lesson not found.");
  }
  const lesson = await getPublishedLesson(user, lessonId);
  return { graph: lesson.graph, isDemo: false };
}

export function requireConcept(graph: KnowledgeGraph, conceptId: string): void {
  if (!graph.concepts.some((c) => c.id === conceptId)) {
    throw new ServiceError(404, "not_found", "That idea is not in this lesson.");
  }
}

/**
 * A streaming text response that reports a failure before it starts. The first piece is
 * read before the response is built, so a missing key or a refused request becomes a normal
 * error response instead of a stream that dies on the first byte.
 */
export async function streamTextResponse(pieces: AsyncGenerator<string>): Promise<Response> {
  const first = await pieces.next();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!first.done) controller.enqueue(encoder.encode(first.value));
        if (!first.done) {
          for await (const piece of pieces) controller.enqueue(encoder.encode(piece));
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await pieces.return(undefined);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
