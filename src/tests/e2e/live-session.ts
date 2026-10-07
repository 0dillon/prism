import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Helpers for e2e tests that need a signed-in user on a real Supabase project. They run
 * only when the credentials are in the environment (locally, via `npm run e2e:live`), so
 * CI, which has none, skips them.
 *
 * Users are throwaway accounts made through the admin API with a random password, and the
 * browser is given their session cookie directly. No credentials are typed into any form.
 */

export const liveEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

export const hasLiveSupabase =
  Boolean(liveEnv.url && liveEnv.anonKey && liveEnv.serviceKey) &&
  !String(liveEnv.url).includes("127.0.0.1");

export function liveAdmin(): SupabaseClient {
  return createClient(liveEnv.url!, liveEnv.serviceKey!, { auth: { persistSession: false } });
}

export interface LiveUser {
  id: string;
  email: string;
  /** A client signed in as this user, for setup that must run as them (for example publishing). */
  db: SupabaseClient;
  cookies: { name: string; value: string; domain: string; path: string }[];
  cleanup(): Promise<void>;
}

export interface LiveUserOptions {
  /** The display name. Defaults to a generated one. */
  name?: string;
  /** Date of birth as YYYY-MM-DD. Left out, the account is not age restricted. */
  birthDate?: string;
}

/** Creates a throwaway confirmed user and returns the session cookies the app expects. */
export async function createLiveUser(
  host: string,
  options: LiveUserOptions = {},
): Promise<LiveUser> {
  const { url, anonKey, serviceKey } = liveEnv;
  if (!url || !anonKey || !serviceKey)
    throw new Error("Supabase environment variables are missing");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = `E2e-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      ...(options.name ? { display_name: options.name } : {}),
      ...(options.birthDate ? { birth_date: options.birthDate } : {}),
    },
  });
  if (created.error) throw created.error;
  const id = created.data.user.id;

  const jar = new Map<string, string>();
  const ssr = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const signedIn = await ssr.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;

  return {
    id,
    email,
    db: ssr,
    cookies: [...jar].map(([name, value]) => ({ name, value, domain: host, path: "/" })),
    cleanup: async () => {
      await admin.auth.admin.deleteUser(id);
    },
  };
}

export interface LiveSchool {
  orgId: string;
  classroomId: string;
  cleanup(): Promise<void>;
}

/**
 * A school with one class taught by `teacherId`, the given students enrolled and the lesson
 * assigned, so those students can open it. Lessons are reached by assignment, not by being
 * published. Removing the school removes the class, its enrollments and its assignment.
 */
export async function createLiveSchool(options: {
  teacherId: string;
  studentIds: string[];
  lessonId: string;
}): Promise<LiveSchool> {
  const admin = liveAdmin();
  const slug = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const org = await admin
    .from("organizations")
    .insert({ name: "E2E School", slug })
    .select("id")
    .single();
  if (org.error) throw org.error;
  const orgId = org.data.id as string;

  const members = await admin
    .from("org_memberships")
    .insert([
      { org_id: orgId, user_id: options.teacherId, role: "teacher" },
      ...options.studentIds.map((id) => ({ org_id: orgId, user_id: id, role: "student" })),
    ]);
  if (members.error) throw members.error;

  const code = await admin.rpc("new_join_code");
  if (code.error) throw code.error;
  const room = await admin
    .from("classrooms")
    .insert({
      org_id: orgId,
      teacher_id: options.teacherId,
      name: "E2E class",
      join_code: code.data,
    })
    .select("id")
    .single();
  if (room.error) throw room.error;
  const classroomId = room.data.id as string;

  const enrolled = await admin
    .from("enrollments")
    .insert(options.studentIds.map((id) => ({ classroom_id: classroomId, student_id: id })));
  if (enrolled.error) throw enrolled.error;
  const assigned = await admin
    .from("assignments")
    .insert({ classroom_id: classroomId, lesson_id: options.lessonId });
  if (assigned.error) throw assigned.error;

  return {
    orgId,
    classroomId,
    cleanup: async () => {
      await admin.from("organizations").delete().eq("id", orgId);
    },
  };
}

/** Whether the project has the school tables, so a spec can skip until migrations are applied. */
export async function hasSchoolSchema(): Promise<boolean> {
  if (!hasLiveSupabase) return false;
  const { error } = await liveAdmin().from("organizations").select("id").limit(1);
  return !error;
}
