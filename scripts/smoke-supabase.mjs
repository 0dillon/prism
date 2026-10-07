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
let orgId;
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
    "other user cannot see a published lesson that is not assigned to them",
    (await b.db.from("lessons").select("id")).data?.length === 0,
  );
  // A school: a classroom owned by user a, user b enrolled, the lesson assigned to it.
  const org = await admin
    .from("organizations")
    .insert({ name: "Smoke School", slug: `smoke-${tag}` })
    .select("id")
    .single();
  orgId = org.data?.id;
  await admin.from("org_memberships").insert({ org_id: orgId, user_id: a.id, role: "teacher" });
  const room = await admin
    .from("classrooms")
    .insert({ org_id: orgId, teacher_id: a.id, name: "Smoke class", join_code: "SMOKE2" })
    .select("id")
    .single();
  check("service role can create a classroom", !room.error, room.error?.message);
  await admin.from("enrollments").insert({ classroom_id: room.data?.id, student_id: b.id });
  const assigned = await a.db
    .from("assignments")
    .insert({ classroom_id: room.data?.id, lesson_id: lessonId });
  check("teacher can assign their lesson", !assigned.error, assigned.error?.message);
  check(
    "enrolled student sees the assigned lesson",
    (await b.db.from("lessons").select("id")).data?.length === 1,
  );
  check(
    "a teacher sees only their own classrooms",
    (await b.db.from("classrooms").select("id")).data?.length === 1 &&
      (await a.db.from("classrooms").select("id")).data?.length === 1,
  );

  await a.db.from("render_profiles").insert({ user_id: a.id, profile: { layout: "cards" } });
  check(
    "profile is private from other users",
    (await b.db.from("render_profiles").select("user_id")).data?.length === 0,
  );

  const concept = await admin.from("concepts").insert({
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
  // Replaying a batch, the way /api/events does, must store nothing new and must not
  // count an answer twice towards mastery.
  const attemptsBefore = (
    await b.db.from("concept_mastery").select("attempts").eq("concept_id", "c_1")
  ).data?.[0]?.attempts;
  const replay = await b.db
    .from("learning_events")
    .upsert([event(1, true), event(2, true), event(3, false)], {
      onConflict: "id",
      ignoreDuplicates: true,
    });
  check("replaying events is accepted", !replay.error, replay.error?.message);
  const stored = await b.db.from("learning_events").select("id").like("id", `SMOKE${tag}%`);
  check(
    "replaying events stores nothing new",
    stored.data?.length === 3,
    String(stored.data?.length),
  );
  const attemptsAfter = (
    await b.db.from("concept_mastery").select("attempts").eq("concept_id", "c_1")
  ).data?.[0]?.attempts;
  check(
    "replaying events does not count an answer twice",
    attemptsBefore === attemptsAfter,
    `${attemptsBefore} -> ${attemptsAfter}`,
  );
  // The learner home reads these three tables as the learner (src/lib/lessons/home-service.ts).
  const homeLessons = await b.db
    .from("lessons")
    .select("id, title, status")
    .eq("status", "published")
    .order("created_at", { ascending: false });
  check(
    "learner home sees the published lesson",
    homeLessons.data?.some((l) => l.id === lessonId) === true,
    homeLessons.error?.message,
  );
  const homeConcepts = await b.db
    .from("concepts")
    .select("lesson_id, id")
    .in("lesson_id", [lessonId]);
  const homeMastery = await b.db
    .from("concept_mastery")
    .select("lesson_id, concept_id, status")
    .in("lesson_id", [lessonId]);
  check(
    "learner home reads concepts and its own mastery",
    !homeConcepts.error &&
      !homeMastery.error &&
      (homeConcepts.data?.length ?? 0) >= 1 &&
      (homeMastery.data?.length ?? 0) >= 1,
    homeConcepts.error?.message ?? homeMastery.error?.message,
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
  if (orgId) await admin.from("organizations").delete().eq("id", orgId);
  for (const id of userIds) await admin.auth.admin.deleteUser(id);
  console.log(results.map((r) => r.line).join("\n"));
  console.log(`cleanup: deleted ${userIds.length} throwaway users`);
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
}
