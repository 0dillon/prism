import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

/**
 * Helpers for e2e tests that need a signed-in user on a real Supabase project. They run
 * only when the credentials are in the environment (locally, via `npm run e2e:live`), so
 * CI, which has none, skips them.
 */

export const liveEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

export const hasLiveSupabase =
  Boolean(liveEnv.url && liveEnv.anonKey && liveEnv.serviceKey) &&
  !String(liveEnv.url).includes("127.0.0.1");

export interface LiveUser {
  id: string;
  cookies: { name: string; value: string; domain: string; path: string }[];
  cleanup(): Promise<void>;
}

/** Creates a throwaway confirmed user and returns the session cookies the app expects. */
export async function createLiveUser(host: string): Promise<LiveUser> {
  const { url, anonKey, serviceKey } = liveEnv;
  if (!url || !anonKey || !serviceKey)
    throw new Error("Supabase environment variables are missing");

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const password = "E2e-test-pw-123";
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
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
    cookies: [...jar].map(([name, value]) => ({ name, value, domain: host, path: "/" })),
    cleanup: async () => {
      await admin.auth.admin.deleteUser(id);
    },
  };
}
