// Live smoke test for a real Supabase project: row-level security, the mastery trigger,
// and signed storage URLs. It creates two throwaway users and one lesson, then deletes
// them. Run it against a development project only:
//
//   npm run smoke:supabase
//
// Reads NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY from the environment (node --env-file=.env.local).
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase environment variables.");
  process.exit(2);
}

const client = (key) =>
  createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = client(serviceKey);
const anon = client(anonKey);
const password = "Smoke-test-pw-123";
const tag = Date.now();
const results = [];
const check = (name, passed, detail = "") =>
  results.push({
    name,
    passed,
    line: `${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
  });
const userIds = [];

async function makeUser(name) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `smoke-${name}-${tag}@example.test`,
    password,
    email_confirm: true,
    user_metadata: { display_name: name },
  });
  if (error) throw error;
  userIds.push(data.user.id);
  const session = client(anonKey);
  const signedIn = await session.auth.signInWithPassword({ email: data.user.email, password });
  if (signedIn.error) throw signedIn.error;
  return { id: data.user.id, db: session };
}

let lessonId;
try {
  const a = await makeUser("a");
  const b = await makeUser("b");

  const profile = await admin.from("users_public").select("display_name").eq("id", a.id).single();
  check(
    "signup trigger created users_public",
    profile.data?.display_name === "a",
    profile.error?.message,
  );

  const anonRead = await anon.from("lessons").select("id").limit(1);
  check("anon role denied on lessons", Boolean(anonRead.error), anonRead.error?.message);

  const created = await a.db
    .from("lessons")
    .insert({ owner_id: a.id, title: "Smoke" })
    .select("id")
    .single();
  check("owner can create lesson", !created.error, created.error?.message);
  lessonId = created.data?.id;
  check(
    "cannot create lesson as someone else",
    Boolean((await a.db.from("lessons").insert({ owner_id: b.id }).select()).error),
  );
  check(
    "other user cannot see a draft",
    (await b.db.from("lessons").select("id")).data?.length === 0,
  );
  await a.db.from("lessons").update({ status: "published", graph_version: 1 }).eq("id", lessonId);
  check(
    "other user sees the published lesson",
    (await b.db.from("lessons").select("id")).data?.length === 1,
  );

  await a.db.from("render_profiles").insert({ user_id: a.id, profile: { layout: "cards" } });
  check(
    "profile is private from other users",
    (await b.db.from("render_profiles").select("user_id")).data?.length === 0,
  );

  const concept = await admin
    .from("concepts")
    .insert({
      id: "c_1",
      lesson_id: lessonId,
      graph_version: 1,
      order_index: 0,
      title: "T",
      summary: "S",
    });
  check("service role can write concepts", !concept.error, concept.error?.message);

  const event = (i, correct, userId = b.id) => ({
    id: `SMOKE${tag}${i}`,
    user_id: userId,
    lesson_id: lessonId,
    graph_version: 1,
    type: "quiz_answered",
    concept_id: "c_1",
    correct,
    layout: "cards",
    occurred_at: new Date(Date.now() + i * 1000).toISOString(),
  });
  const inserted = await b.db.from("learning_events").insert([event(1, true), event(2, true)]);
  check("learner inserts own events", !inserted.error, inserted.error?.message);
  const mastered = await b.db
    .from("concept_mastery")
    .select("status,attempts")
    .eq("concept_id", "c_1");
  check(
    "mastered after two correct answers",
    mastered.data?.[0]?.status === "mastered",
    JSON.stringify(mastered.data),
  );
  await b.db.from("learning_events").insert(event(3, false));
  const regressed = await b.db.from("concept_mastery").select("status").eq("concept_id", "c_1");
  check(
    "a later wrong answer returns it to in_progress",
    regressed.data?.[0]?.status === "in_progress",
  );
  check(
    "cannot forge an event for another user",
    Boolean((await b.db.from("learning_events").insert(event(9, true, a.id))).error),
  );
  check(
    "other users cannot read this learner's events or mastery",
    (await a.db.from("concept_mastery").select("id")).data?.length === 0 &&
      (await a.db.from("learning_events").select("id")).data?.length === 0,
  );

  const path = `${a.id}/${lessonId}/source.txt`;
  const upload = await a.db.storage.from("sources").createSignedUploadUrl(path);
  check("signed upload URL created", !upload.error, upload.error?.message);
  const put = await a.db.storage
    .from("sources")
    .uploadToSignedUrl(path, upload.data.token, new Blob(["hello prism"], { type: "text/plain" }));
  check("upload through the signed URL works", !put.error, put.error?.message);
  const download = await a.db.storage.from("sources").createSignedUrl(path, 3600);
  check("signed download URL created", !download.error, download.error?.message);
  const body = download.data ? await (await fetch(download.data.signedUrl)).text() : "";
  check("download returns the uploaded content", body === "hello prism", body.slice(0, 40));
  const other = await b.db.storage.from("sources").createSignedUrl(path, 60);
  check("another user cannot sign this source", Boolean(other.error) || !other.data?.signedUrl);
  await admin.storage.from("sources").remove([path]);
} catch (error) {
  results.push({
    name: "error",
    passed: false,
    line: `ERROR  ${error?.message ?? JSON.stringify(error)}`,
  });
} finally {
  if (lessonId) await admin.from("lessons").delete().eq("id", lessonId);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  console.log(results.map((r) => r.line).join("\n"));
  console.log(`cleanup: deleted ${userIds.length} throwaway users`);
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
}
