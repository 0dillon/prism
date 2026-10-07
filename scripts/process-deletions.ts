// Carries out account deletion requests (PRD 6.4, P6-16). A learner asks for deletion on
// their account page; the request waits here for the operator, because removing an account
// cannot be undone.
//
//   npm run account:deletions                  lists the open requests, changes nothing
//   npm run account:deletions -- --apply       deletes each requester's account and records
//   npm run account:deletions -- --apply --older-than=7
//                                              only those who asked at least 7 days ago
//
// Deleting the auth user removes everything that belongs to them (settings, events, mastery,
// enrollments, consent, requests) through the database's cascade rules. Run it with the
// service role key from .env.local. The date a request was made is the only thing printed
// besides an email address, and nothing from their learning records is read.
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing Supabase environment variables. Run with --env-file=.env.local.");
  process.exit(2);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const olderThan = Number(args.find((a) => a.startsWith("--older-than="))?.split("=")[1] ?? 0);

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const cutoff = new Date(Date.now() - olderThan * 86_400_000).toISOString();
  const { data, error } = await admin
    .from("data_requests")
    .select("id, user_id, created_at")
    .eq("kind", "delete")
    .eq("status", "requested")
    .lte("created_at", cutoff)
    .order("created_at");
  if (error) throw error;
  const requests = data ?? [];
  if (requests.length === 0) {
    console.log("No open deletion requests.");
    return;
  }

  for (const request of requests) {
    const found = await admin.auth.admin.getUserById(request.user_id);
    const email = found.data.user?.email ?? "(account already gone)";
    const asked = request.created_at.slice(0, 10);
    if (!apply) {
      console.log(`would delete ${email}, asked ${asked}`);
      continue;
    }
    if (!found.data.user) {
      console.log(`skipped ${email}`);
      continue;
    }
    const removed = await admin.auth.admin.deleteUser(request.user_id);
    if (removed.error) {
      console.error(`FAILED ${email}: ${removed.error.message}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`deleted ${email}, asked ${asked}`);
  }
  if (!apply) console.log("\nNothing was changed. Run with --apply to delete these accounts.");
}

main().catch((error) => {
  console.error("failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
