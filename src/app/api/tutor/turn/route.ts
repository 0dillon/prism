import type { NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody } from "@/lib/api/http";
import { tutorTurn, TutorTurnRequest } from "@/lib/ai/tutor/turn";
import {
  isDemoLesson,
  loadTutorLesson,
  requireConcept,
  streamTextResponse,
} from "@/lib/ai/tutor/service";
import { createRateLimiter } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

// Each turn is a model call. Full per-user and per-IP limits: P8-05.
const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

function callerKey(request: NextRequest, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || request.headers.get("x-real-ip") || "unknown"}`;
}

/**
 * The spoken tutor's reply, streamed as plain text (PRD 5.6.3). Uses only the lesson.
 * Signed-in learners use their lessons; anyone may use the public demo lesson.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const user = data.user;

    const input = await parseBody(request, TutorTurnRequest);
    const lesson = await loadTutorLesson(input.lessonId, user ? supabase : null);
    requireConcept(lesson.graph, input.conceptId);

    const limit = limiter.consume(
      callerKey(request, isDemoLesson(input.lessonId) ? null : (user?.id ?? null)),
    );
    if (!limit.allowed) {
      const response = jsonError(
        429,
        "rate_limited",
        "That was a lot of questions. Please wait a moment and try again.",
      );
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    return await streamTextResponse(
      tutorTurn({ graph: lesson.graph, conceptId: input.conceptId, intent: input.intent }),
    );
  } catch (error) {
    return errorResponse(error, "POST /api/tutor/turn");
  }
}
