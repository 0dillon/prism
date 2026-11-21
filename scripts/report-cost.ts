// Prints ingestion cost per lesson against the budget target (PRD 6.2, P8-06).
//
//   npm run report:cost
//
// Reads every ingestion job's recorded usage with the service role key from .env.local. It reads
// lesson titles and usage only, never lesson content or anything about learners.
import { createClient } from "@supabase/supabase-js";
import { formatCostTable, summarizeCost, type JobUsage } from "../src/lib/reports/cost";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing Supabase environment variables. Run with --env-file=.env.local.");
  process.exit(2);
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PAGE = 1000;

async function main() {
  const jobs: JobUsage[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("ingestion_jobs")
      .select("lesson_id, tokens_in, tokens_out, cost_usd, lessons(title)")
      .order("created_at")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      const lesson = Array.isArray(row.lessons) ? row.lessons[0] : row.lessons;
      jobs.push({
        lessonId: row.lesson_id,
        title: (lesson as { title?: string } | null)?.title ?? "",
        tokensIn: Number(row.tokens_in),
        tokensOut: Number(row.tokens_out),
        costUsd: Number(row.cost_usd),
      });
    }
    if ((data ?? []).length < PAGE) break;
  }
  console.log(formatCostTable(summarizeCost(jobs)));
}

main().catch((error) => {
  // Supabase errors are plain objects with a message, not Error instances.
  const message = (error as { message?: unknown })?.message ?? String(error);
  console.error(`report failed: ${message}`);
  if (String(message).includes("fetch failed")) {
    console.error("The database could not be reached. If the project is paused, restore it first.");
  }
  process.exit(1);
});
