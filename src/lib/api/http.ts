import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";

/** An error with an HTTP status and a code a client can switch on. The message is safe to show. */
export class ServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export function jsonError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Maps a thrown error to a response. Unexpected errors are logged and reported generically. */
export function errorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof ServiceError) return jsonError(error.status, error.code, error.message);
  logger.error("unhandled api error", {
    context,
    error: error instanceof Error ? error.message : String(error),
  });
  return jsonError(500, "internal_error", "Something went wrong. Please try again.");
}

export type UserClient = SupabaseClient<Database>;

/** The signed-in user and a client that runs as them, or a 401 response. */
export async function requireUser(): Promise<
  { ok: true; user: User; supabase: UserClient } | { ok: false; response: NextResponse }
> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { ok: false, response: jsonError(401, "unauthorized", "Sign in to continue.") };
  }
  return { ok: true, user: data.user, supabase };
}

/** Parses a JSON request body with a schema, or throws a 400 ServiceError. */
export async function parseBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ServiceError(400, "invalid_json", "The request body must be JSON.");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first.path.length ? `${first.path.join(".")}: ` : "";
    throw new ServiceError(400, "invalid_request", `${where}${first.message}`);
  }
  return result.data;
}

const Uuid = z.uuid();

/** Validates a path parameter that must be a UUID. */
export function parseId(value: string, noun = "Lesson"): string {
  const result = Uuid.safeParse(value);
  if (!result.success) throw new ServiceError(404, "not_found", `${noun} not found.`);
  return result.data;
}
