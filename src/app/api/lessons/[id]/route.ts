import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { getPublishedLesson } from "@/lib/lessons/publish-service";

/** The published Knowledge Graph for a learner who is entitled to the lesson (PRD 7.5). */
export async function GET(_request: NextRequest, context: RouteContext<"/api/lessons/[id]">) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const lesson = await getPublishedLesson(auth.supabase, parseId(id));
    return NextResponse.json(lesson);
  } catch (error) {
    return errorResponse(error, "GET /api/lessons/[id]");
  }
}
