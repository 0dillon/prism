import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody } from "@/lib/api/http";
import { createRateLimiter } from "@/lib/rate-limit";
import { parseNeedsRequest, ParseNeedsInput } from "@/lib/profile/parse-service";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Each call is a model call, so keep it cheap to abuse. Full per-user and per-IP limits: P8-05.
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

function callerKey(request: NextRequest, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || request.headers.get("x-real-ip") || "unknown"}`;
}

/** Free text to a profile change. Open to signed-out visitors, with a rate limit (PRD 7.5). */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    const userId = data.user?.id ?? null;

    const limit = limiter.consume(callerKey(request, userId));
    if (!limit.allowed) {
      const response = jsonError(
        429,
        "rate_limited",
        "That was a lot of requests. Please wait a moment and try again.",
      );
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }

    const input = await parseBody(request, ParseNeedsInput);
    const result = await parseNeedsRequest(input, { admin: createAdminClient(), userId });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "POST /api/profile/parse");
  }
}
