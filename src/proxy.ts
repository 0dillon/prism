import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 renamed middleware to proxy; this is the PRD's src/middleware.ts.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Skip static assets and image optimization.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts/|earcons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp4|woff2)$).*)",
  ],
};
