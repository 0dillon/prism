import { NextResponse, after, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { startIngestion } from "@/lib/lessons/service";
import { createAdminClient } from "@/lib/supabase/admin";

// The MVP runs the pipeline inside this request's lifetime (after the response is sent),
// so allow it the longest duration the host permits. Inngest replaces this in P2-20.
export const maxDuration = 300;

/** Starts or resumes ingestion for a lesson the caller owns. Replies at once; poll /status. */
export async function POST(
  _request: NextRequest,
  context: RouteContext<"/api/lessons/[id]/ingest">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const started = await startIngestion(
      { user: auth.supabase, admin: createAdminClient() },
      auth.user.id,
      parseId(id),
    );

    after(async () => {
      try {
        await started.run();
      } catch (error) {
        // runIngestion records its own failures; this only catches setup errors.
        logger.error("ingestion run crashed", {
          jobId: started.jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return NextResponse.json({ jobId: started.jobId, status: "processing" }, { status: 202 });
  } catch (error) {
    return errorResponse(error, "POST /api/lessons/[id]/ingest");
  }
}
