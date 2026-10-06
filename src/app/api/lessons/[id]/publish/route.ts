import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { publishLesson } from "@/lib/lessons/publish-service";

/** Publishes a reviewed lesson so entitled learners can open it (PRD CE-2, 7.5). */
export async function POST(
  _request: NextRequest,
  context: RouteContext<"/api/lessons/[id]/publish">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const published = await publishLesson(auth.supabase, auth.user.id, parseId(id));
    return NextResponse.json(published);
  } catch (error) {
    return errorResponse(error, "POST /api/lessons/[id]/publish");
  }
}
