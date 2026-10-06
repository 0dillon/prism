import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { parseSessionIntent, SessionIntentRequest } from "@/lib/ai/intents/session";
import { createRateLimiter } from "@/lib/rate-limit";

// Only phrases the local matcher misses reach the model, but cap it anyway. Full limits: P8-05.
const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

/** One utterance in, one SessionIntent out (PRD 5.4 B). For signed-in learners. */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const limit = limiter.consume(`user:${auth.user.id}`);
    if (!limit.allowed) {
      const response = jsonError(
        429,
        "rate_limited",
        "That was a lot of requests. Please wait a moment and try again.",
      );
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const input = await parseBody(request, SessionIntentRequest);
    const result = await parseSessionIntent({
      utterance: input.utterance,
      context: input.context,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "POST /api/session/intent");
  }
}
