// Seeds the demo (PRD P9-02): a teacher, three learners with their own presets, and the
// demo lesson reviewed and published. Safe to run again: what exists is reused.
//
//   DEMO_PASSWORD=<8+ characters> npm run seed:demo
//   DEMO_PASSWORD=... npm run seed:demo -- --with-progress   (also seeds some progress)
//   npm run seed:demo -- --teardown                          (removes the demo again)
//
// The password is read from the environment and never written to a file. Everything is
// done in the project named by .env.local (the service role key is needed).
import { createClient } from "@supabase/supabase-js";
import { SAMPLE_LESSON } from "../src/lib/demo/sample-lesson";
import {
  DEMO_LEARNER_ACCOUNTS,
  DEMO_TEACHER,
  isValidDemoPassword,
  progressEvents,
  type DemoAccount,
} from "../src/lib/demo/seed-plan";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase environment variables. Run with --env-file=.env.local.");
  process.exit(2);
}

const args = new Set(process.argv.slice(2));
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);

async function findUserId(email: string): Promise<string | null> {
  // The admin API has no lookup by email, so page through the users.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (data.users.length < 200) break;
  }
  return null;
}

async function ensureUser(account: DemoAccount, password: string): Promise<string> {
  const existing = await findUserId(account.email);
  if (existing) {
    // Keep the password the presenter set, so signing in works after a re-run.
    await admin.auth.admin.updateUserById(existing, { password });
    return existing;
  }
  const { data, error } = await admin.auth.admin.createUser({
    email: account.email,
    password,
    email_confirm: true,
    user_metadata: { display_name: account.displayName },
  });
  if (error || !data.user) throw error ?? new Error(`could not create ${account.email}`);
  return data.user.id;
}
const DEMO_ORG_SLUG = "prism-demo";
const DEMO_JOIN_CODE = "DEMO22";

/** The school the demo learners belong to: a class taught by the demo teacher, with the lesson assigned. */
async function ensureClassroom(
  teacherId: string,
  lessonId: string,
): Promise<{ orgId: string; classroomId: string }> {
  let org = (await admin.from("organizations").select("id").eq("slug", DEMO_ORG_SLUG).maybeSingle())
    .data;
  if (!org) {
    const created = await admin
      .from("organizations")
      .insert({ name: "Prism Demo School", slug: DEMO_ORG_SLUG, created_by: teacherId })
      .select("id")
      .single();
    if (created.error) throw created.error;
    org = created.data;
  }
  const member = await admin
    .from("org_memberships")
    .upsert(
      { org_id: org.id, user_id: teacherId, role: "teacher" },
      { onConflict: "org_id,user_id" },
    );
  if (member.error) throw member.error;

  let room = (
    await admin.from("classrooms").select("id").eq("join_code", DEMO_JOIN_CODE).maybeSingle()
  ).data;
  if (!room) {
    const created = await admin
      .from("classrooms")
      .insert({
        org_id: org.id,
        teacher_id: teacherId,
        name: "Demo class",
        grade: "5",
        subject: "Science",
        join_code: DEMO_JOIN_CODE,
      })
      .select("id")
      .single();
    if (created.error) throw created.error;
    room = created.data;
  }
  const assigned = await admin
    .from("assignments")
    .upsert(
      { classroom_id: room.id, lesson_id: lessonId },
      { onConflict: "classroom_id,lesson_id" },
    );
  if (assigned.error) throw assigned.error;
  return { orgId: org.id, classroomId: room.id };
}

async function teardown() {
  // Removing the organization removes its classrooms, enrollments and assignments.
  await admin.from("organizations").delete().eq("slug", DEMO_ORG_SLUG);
  for (const account of [DEMO_TEACHER, ...DEMO_LEARNER_ACCOUNTS]) {
    const id = await findUserId(account.email);
    if (id) {
      await admin.auth.admin.deleteUser(id);
      console.log(`removed ${account.email}`);
    }
  }
  console.log("The demo has been removed (lessons and progress go with their users).");
}

async function main() {
  if (args.has("--teardown")) return teardown();

  const password = process.env.DEMO_PASSWORD;
  if (!isValidDemoPassword(password)) {
    console.error("Set DEMO_PASSWORD to a password of at least 8 characters.");
    process.exit(2);
  }

  const teacherId = await ensureUser(DEMO_TEACHER, password);
  await admin
    .from("users_public")
    .update({ display_name: DEMO_TEACHER.displayName, is_creator: false })
    .eq("id", teacherId);
  console.log(`teacher ready: ${DEMO_TEACHER.email}`);

  // The lesson: reuse the teacher's demo lesson if there is one, else make it.
  const teacher = createClient(url!, anonKey!, options);
  const signedIn = await teacher.auth.signInWithPassword({ email: DEMO_TEACHER.email, password });
  if (signedIn.error) throw signedIn.error;

  let lesson = (
    await teacher
      .from("lessons")
      .select("id, status, graph_version")
      .eq("owner_id", teacherId)
      .eq("title", SAMPLE_LESSON.title)
      .maybeSingle()
  ).data;
  if (!lesson) {
    const created = await teacher
      .from("lessons")
      .insert({
        owner_id: teacherId,
        title: SAMPLE_LESSON.title,
        status: "needs_review",
        source_type: "md",
        graph: { ...SAMPLE_LESSON },
      })
      .select("id, status, graph_version")
      .single();
    if (created.error) throw created.error;
    lesson = created.data;
  }

  // Published through the same function the review page uses, so every table is filled.
  if (lesson.status === "needs_review") {
    const graph = { ...SAMPLE_LESSON, lessonId: lesson.id };
    const published = await teacher.rpc("publish_lesson", {
      p_lesson_id: lesson.id,
      p_graph: graph,
    });
    if (published.error) throw published.error;
    lesson = { ...lesson, status: "published", graph_version: published.data as number };
  }
  console.log(`lesson published: ${lesson.id} (version ${lesson.graph_version})`);

  const { orgId, classroomId } = await ensureClassroom(teacherId, lesson.id);
  console.log("classroom ready: Demo class (join code " + DEMO_JOIN_CODE + ")");

  for (const learner of DEMO_LEARNER_ACCOUNTS) {
    const id = await ensureUser(learner, password);
    const enrolled = await admin
      .from("enrollments")
      .upsert(
        { classroom_id: classroomId, student_id: id },
        { onConflict: "classroom_id,student_id" },
      );
    if (enrolled.error) throw enrolled.error;
    const membership = await admin
      .from("org_memberships")
      .upsert({ org_id: orgId, user_id: id, role: "student" }, { onConflict: "org_id,user_id" });
    if (membership.error) throw membership.error;
    await admin.from("users_public").update({ display_name: learner.displayName }).eq("id", id);
    const saved = await admin
      .from("render_profiles")
      .upsert({ user_id: id, profile: learner.profile }, { onConflict: "user_id" });
    if (saved.error) throw saved.error;
    console.log(`learner ready: ${learner.email} (${learner.profile.preset})`);

    if (args.has("--with-progress")) {
      const events = progressEvents({
        userId: id,
        lessonId: lesson.id,
        graphVersion: lesson.graph_version,
        learner,
      });
      if (events.length > 0) {
        const inserted = await admin
          .from("learning_events")
          .upsert(events, { onConflict: "id", ignoreDuplicates: true });
        if (inserted.error) throw inserted.error;
      }
      console.log(`  progress seeded: ${learner.masteredIdeas} ideas`);
    }
  }

  console.log("\nThe demo is ready. Sign in as any account above with the password you set.");
  console.log(
    "Sign clips are not seeded: there are none yet, so key terms are fingerspelled (PRD 9.3).",
  );
}

main().catch((error) => {
  console.error("seed failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
