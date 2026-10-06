import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { getLessonStatus } from "@/lib/lessons/service";

/** The stage and progress of a lesson's ingestion, for the upload page to poll. */
export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/lessons/[id]/status">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const status = await getLessonStatus(auth.supabase, auth.user.id, parseId(id));
    return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "GET /api/lessons/[id]/status");
  }
}
