import { NextResponse } from "next/server";
import { logger } from "@/lib/log";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

// A free Supabase project is paused after a week with no activity. A scheduled job calls this
// once a day (vercel.json, and .github/workflows/keepalive.yml as a backup) so the database sees
// a real query. It reads one id and returns nothing about it.
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 30, windowMs: 60 * 60_000 });

export async function GET() {
  if (!limiter.consume("keepalive").allowed) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  const { error } = await createAdminClient().from("lessons").select("id").limit(1);
  if (error) {
    logger.error("keepalive query failed", { error: error.message });
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
