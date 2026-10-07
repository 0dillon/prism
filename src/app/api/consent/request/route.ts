import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { GuardianRequest, requestGuardianConsent } from "@/lib/consent/service";
import { createRateLimiter } from "@/lib/rate-limit";

const limiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });

/**
 * A child under 13 gives a parent or guardian's email. The link goes to the guardian; this
 * response says only that the request was made, never the link or the token.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const limit = limiter.consume(`user:${auth.user.id}`);
    if (!limit.allowed) {
      const response = jsonError(429, "rate_limited", "Too many requests. Please wait a while.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const input = await parseBody(request, GuardianRequest);
    const name = String(auth.user.user_metadata?.display_name ?? "your child");
    const result = await requestGuardianConsent(
      auth.supabase,
      input,
      name,
      new URL(request.url).origin,
    );
    return NextResponse.json({ requested: result.requested });
  } catch (error) {
    return errorResponse(error, "POST /api/consent/request");
  }
}
