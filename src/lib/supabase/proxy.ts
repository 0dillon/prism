import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/auth/paths";
import { clientEnv } from "@/lib/env";
import type { Database } from "./database.types";

/**
 * Refreshes the Supabase session cookie and applies route protection. Called from
 * src/proxy.ts on every navigation.
 *
 * This is an optimistic check that keeps signed-out visitors out of protected pages.
 * It is not the security boundary: row-level security and the checks in each route
 * handler are.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });
  const env = clientEnv();

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getClaims verifies the token, unlike reading the session from the cookie.
  const { data } = await supabase.auth.getClaims();
  const isSignedIn = Boolean(data?.claims?.sub);

  const decision = decideAccess({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    isSignedIn,
  });

  if (decision.action === "redirect") {
    const redirect = NextResponse.redirect(new URL(decision.location, request.url));
    // Keep any refreshed session cookies on the redirect.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  }

  return response;
}
