import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { CreateOrgRequest, createOrganization } from "@/lib/orgs/service";
import { createRateLimiter } from "@/lib/rate-limit";

// Setting up a school is rare; this stops a script from filling the table.
const limiter = createRateLimiter({ limit: 5, windowMs: 60 * 60_000 });

/** Creates an organization with the signed-in user as its principal (PRD 5.8). */
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
    const { name } = await parseBody(request, CreateOrgRequest);
    const org = await createOrganization(auth.supabase, name);
    return NextResponse.json(org, { status: 201 });
  } catch (error) {
    return errorResponse(error, "POST /api/orgs");
  }
}
