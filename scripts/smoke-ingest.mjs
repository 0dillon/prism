// Live end-to-end check of the ingestion API: sign in, create a lesson, upload a file to
// the signed URL, start ingestion, poll until it is ready for review, then inspect the
// draft graph. Uses a real Supabase project and a real LLM, so it costs a few LLM calls.
//
//   npm run dev        (in another terminal)
//   npm run smoke:ingest
//
// It creates one throwaway user and lesson and deletes them at the end.
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

const base = process.env.BASE_URL ?? "http://localhost:3000";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error("Missing Supabase environment variables.");
  process.exit(2);
}

const SOURCE = `# The Water Cycle

Water on Earth is always moving. It travels between the oceans, the air, and the land in a loop called the water cycle.

## Evaporation

The sun warms water in oceans, lakes, and rivers. Some of the water turns into water vapor, a gas, and rises into the air. This change from liquid to gas is called evaporation.

## Condensation

High in the sky the air is cold. Water vapor cools there and turns back into tiny droplets of liquid water. This is called condensation. Billions of droplets gather together to form clouds.

## Precipitation

When the droplets in a cloud grow heavy, they fall to the ground. Rain, snow, sleet, and hail are all forms of precipitation. The water then collects in rivers, lakes, and oceans, and the cycle begins again.
`;

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const tag = Date.now();
const email = `smoke-ingest-${tag}@example.test`;
const password = "Smoke-test-pw-123";
const results = [];
const check = (name, passed, detail = "") => {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

let userId;
let lessonId;
let storagePath;

async function api(path, cookie, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Some responses have no body.
  }
  return { status: response.status, body };
}

try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user.id;

  // Sign in through @supabase/ssr so the session cookie is exactly what the app expects.
  const jar = new Map();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const signedIn = await ssr.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  const unauth = await api("/api/lessons", "", {
    method: "POST",
    body: JSON.stringify({ fileName: "a.md", fileSize: 10 }),
  });
  check("signed-out request is rejected", unauth.status === 401, `status ${unauth.status}`);

  const bytes = new TextEncoder().encode(SOURCE);
  const made = await api("/api/lessons", cookie, {
    method: "POST",
    body: JSON.stringify({ fileName: "water-cycle.md", fileSize: bytes.length }),
  });
  check("POST /api/lessons creates a lesson", made.status === 201, `status ${made.status}`);
  lessonId = made.body.lessonId;
  storagePath = made.body.upload.path;

  const uploader = createClient(url, anonKey, { auth: { persistSession: false } });
  await uploader.auth.signInWithPassword({ email, password });
  const uploaded = await uploader.storage
    .from("sources")
    .uploadToSignedUrl(
      storagePath,
      made.body.upload.token,
      new Blob([bytes], { type: "text/markdown" }),
    );
  check("file uploads through the signed URL", !uploaded.error, uploaded.error?.message);

  const started = await api(`/api/lessons/${lessonId}/ingest`, cookie, { method: "POST" });
  check("POST /ingest returns 202 at once", started.status === 202, `status ${started.status}`);

  const again = await api(`/api/lessons/${lessonId}/ingest`, cookie, { method: "POST" });
  check("a second start while running is refused", again.status === 409, `status ${again.status}`);

  const seen = [];
  let final;
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await api(`/api/lessons/${lessonId}/status`, cookie);
    const line = `${status.body.stage}@${status.body.progress}`;
    if (seen.at(-1) !== line) seen.push(line);
    if (status.body.ready || status.body.error) {
      final = status.body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log(`      stages: ${seen.join(" -> ")}`);
  check("polling reaches ready for review", final?.ready === true, final?.error ?? "");

  const lesson = await admin
    .from("lessons")
    .select("status, title, graph, graph_version")
    .eq("id", lessonId)
    .single();
  const graph = lesson.data?.graph;
  check(
    "lesson status is needs_review",
    lesson.data?.status === "needs_review",
    lesson.data?.status,
  );
  check(
    "draft graph has concepts and quiz items",
    graph?.concepts?.length >= 3 && graph?.quizItems?.length >= 6,
    `${graph?.concepts?.length} concepts, ${graph?.quizItems?.length} items`,
  );
  const flat = SOURCE.replace(/\s+/g, " ").toLowerCase();
  const grounded = graph?.concepts?.every((c) =>
    flat.includes(c.source.excerpt.replace(/\s+/g, " ").toLowerCase()),
  );
  check("every concept excerpt is verbatim in the source", Boolean(grounded));
  const perConcept = graph?.concepts?.every((c) => {
    const items = graph.quizItems.filter((q) => q.conceptId === c.id);
    return items.length >= 2 && items.some((q) => q.type === "mcq");
  });
  check("every concept has 2+ quiz items including a multiple choice", Boolean(perConcept));
  const job = await admin
    .from("ingestion_jobs")
    .select("stage, progress, tokens_in, tokens_out")
    .eq("lesson_id", lessonId)
    .single();
  check(
    "token usage was recorded on the job",
    Number(job.data?.tokens_in) > 0 && Number(job.data?.tokens_out) > 0,
    `${job.data?.tokens_in} in / ${job.data?.tokens_out} out`,
  );
  console.log(
    `      title: ${lesson.data?.title} | sections: ${graph?.sections?.map((s) => s.title).join(", ")}`,
  );
} catch (error) {
  console.log(`ERROR  ${error?.message ?? JSON.stringify(error)}`);
  results.push(false);
} finally {
  if (storagePath) await admin.storage.from("sources").remove([storagePath]);
  if (lessonId) await admin.from("lessons").delete().eq("id", lessonId);
  if (userId) await admin.auth.admin.deleteUser(userId);
  console.log("cleanup: removed the throwaway user, lesson and file");
  process.exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1;
}
