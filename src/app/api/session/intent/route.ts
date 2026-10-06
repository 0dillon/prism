import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { parseSessionIntent, SessionIntentRequest } from "@/lib/ai/intents/session";
import { isDemoLesson } from "@/lib/ai/tutor/service";
import { createRateLimiter } from "@/lib/rate-limit";

// Only phrases the local matcher misses reach the model, but cap it anyway. Full limits: P8-05.
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

function addressKey(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || request.headers.get("x-real-ip") || "unknown"}`;
}

/**
 * One utterance in, one SessionIntent out (PRD 5.4 B). For signed-in learners, and for
 * anyone using the public demo lesson, who are limited by address instead.
 */
export async function POST(request: NextRequest) {
  try {
    const input = await parseBody(request, SessionIntentRequest);

    let key: string;
    if (input.lessonId && isDemoLesson(input.lessonId)) {
      key = addressKey(request);
    } else {
      const auth = await requireUser();
      if (!auth.ok) return auth.response;
      key = `user:${auth.user.id}`;
    }

    const limit = limiter.consume(key);
    if (!limit.allowed) {
      const response = jsonError(
        429,
        "rate_limited",
        "That was a lot of requests. Please wait a moment and try again.",
      );
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const result = await parseSessionIntent({
      utterance: input.utterance,
      context: input.context,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "POST /api/session/intent");
  }
}
