import { NextResponse, after, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { publishLesson } from "@/lib/lessons/publish-service";
import { prewarmPlainVariants } from "@/lib/lessons/variant-service";
import { createAdminClient } from "@/lib/supabase/admin";

// Prewarming variants runs after the response and can take a while.
export const maxDuration = 120;

/** Publishes a reviewed lesson so entitled learners can open it (PRD CE-2, 7.5). */
export async function POST(
  _request: NextRequest,
  context: RouteContext<"/api/lessons/[id]/publish">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const lessonId = parseId(id);
    const published = await publishLesson(auth.supabase, auth.user.id, lessonId);

    // Make the plain reading level instantly available. Never blocks or fails the publish.
    after(async () => {
      try {
        const result = await prewarmPlainVariants(createAdminClient(), lessonId);
        logger.info("prewarmed plain variants", { lessonId, ...result });
      } catch (error) {
        logger.warn("variant prewarm crashed", {
          lessonId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return NextResponse.json(published);
  } catch (error) {
    return errorResponse(error, "POST /api/lessons/[id]/publish");
  }
}
