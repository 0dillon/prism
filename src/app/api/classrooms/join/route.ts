import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, jsonError, parseBody, requireUser } from "@/lib/api/http";
import { JoinClassRequest, joinClassroom } from "@/lib/classrooms/students";
import { createRateLimiter } from "@/lib/rate-limit";

// Codes are short, so guessing is slowed down: a handful of tries a minute per user.
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

/** A signed-in student joins a class with its code. */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const limit = limiter.consume(`user:${auth.user.id}`);
    if (!limit.allowed) {
      const response = jsonError(429, "rate_limited", "Too many tries. Please wait a minute.");
      response.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return response;
    }
    const { code } = await parseBody(request, JoinClassRequest);
    return NextResponse.json(await joinClassroom(auth.supabase, code));
  } catch (error) {
    return errorResponse(error, "POST /api/classrooms/join");
  }
}
