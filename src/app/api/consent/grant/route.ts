import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody } from "@/lib/api/http";
import { GrantConsentRequest, grantGuardianConsent } from "@/lib/consent/service";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

// The guardian has no account, so this is limited by address. The token is 256 bits, so this only
// slows down guessing.
const limiter = createRateLimiter({ limit: 20, windowMs: 60 * 60_000 });

/** A parent or guardian agrees by following the link they were sent. No sign-in is needed. */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const limit = limiter.consume(`ip:${ip}`);
    if (!limit.allowed) {
      const response = jsonError(429, "rate_limited", "Too many attempts. Please wait a while.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const { token } = await parseBody(request, GrantConsentRequest);
    await grantGuardianConsent(createAdminClient(), token);
    return NextResponse.json({ granted: true });
  } catch (error) {
    return errorResponse(error, "POST /api/consent/grant");
  }
}
