import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, ServiceError } from "@/lib/api/http";
import { gradeShortAnswer, GradeRequest } from "@/lib/ai/tutor/grade";
import { isDemoLesson, loadTutorLesson } from "@/lib/ai/tutor/service";
import { createRateLimiter } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";

// Only answers the local check cannot settle reach the model, but cap it anyway. Full limits: P8-05.
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

function callerKey(request: NextRequest, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || request.headers.get("x-real-ip") || "unknown"}`;
}

/** Grades a short answer: `{ correct, verdict, feedback }` (PRD 5.6.3). */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const user = data.user;

    const input = await parseBody(request, GradeRequest);
    const lesson = await loadTutorLesson(input.lessonId, user ? supabase : null);
    const item = lesson.graph.quizItems.find((q) => q.id === input.quizItemId);
    if (!item) throw new ServiceError(404, "not_found", "That question is not in this lesson.");
    if (item.type !== "short_answer") {
      throw new ServiceError(400, "invalid_request", "Only short answers are graded here.");
    }

    const limit = limiter.consume(
      callerKey(request, isDemoLesson(input.lessonId) ? null : (user?.id ?? null)),
    );
    if (!limit.allowed) {
      const response = jsonError(
        429,
        "rate_limited",
        "That was a lot of answers. Please wait a moment and try again.",
      );
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const result = await gradeShortAnswer({ item, answer: input.answer });
    return NextResponse.json({
      correct: result.correct,
      verdict: result.verdict,
      feedback: result.feedback,
    });
  } catch (error) {
    return errorResponse(error, "POST /api/tutor/grade");
  }
}
