import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, parseId, requireUser } from "@/lib/api/http";
import { InviteRequest, inviteToOrg } from "@/lib/orgs/service";
import { createRateLimiter } from "@/lib/rate-limit";

const limiter = createRateLimiter({ limit: 60, windowMs: 60 * 60_000 });

/** Invites someone to the organization with a role. Principal only. */
export async function POST(request: NextRequest, context: RouteContext<"/api/orgs/[id]/invites">) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const orgId = parseId((await context.params).id);
    const limit = limiter.consume(`user:${auth.user.id}`);
    if (!limit.allowed) {
      const response = jsonError(429, "rate_limited", "Too many invitations. Please wait a while.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const input = await parseBody(request, InviteRequest);
    const invite = await inviteToOrg(auth.supabase, orgId, input, new URL(request.url).origin);
    return NextResponse.json(invite, { status: 201 });
  } catch (error) {
    return errorResponse(error, "POST /api/orgs/[id]/invites");
  }
}
