import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { EventBatchRequest, recordEvents } from "@/lib/events/service";
import { createRateLimiter } from "@/lib/rate-limit";

// A learner sends a batch every five seconds at most; this leaves room for retries.
const limiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

/**
 * Stores a batch of learning events for the signed-in learner (PRD 5.7). The user comes from
 * the session, never from the request, and an id already stored is ignored, so a repeated
 * batch counts each event once.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const limit = limiter.consume(`user:${auth.user.id}`);
    if (!limit.allowed) {
      const response = jsonError(429, "rate_limited", "Too many requests. Please wait a moment.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const { events } = await parseBody(request, EventBatchRequest);
    const result = await recordEvents(auth.supabase, auth.user.id, events);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "POST /api/events");
  }
}
