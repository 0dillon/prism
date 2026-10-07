import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { AcceptInviteRequest, acceptInvitation } from "@/lib/orgs/service";
import { createRateLimiter } from "@/lib/rate-limit";

// Tokens are long and random; this only slows down guessing.
const limiter = createRateLimiter({ limit: 20, windowMs: 60 * 60_000 });

/** Accepts an invitation for the signed-in user. The database checks the email and expiry. */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const limit = limiter.consume(`user:${auth.user.id}`);
    if (!limit.allowed) {
      const response = jsonError(429, "rate_limited", "Too many attempts. Please wait a while.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const { token } = await parseBody(request, AcceptInviteRequest);
    return NextResponse.json(await acceptInvitation(auth.supabase, token));
  } catch (error) {
    return errorResponse(error, "POST /api/invites/accept");
  }
}
