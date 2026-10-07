import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { regenerateJoinCode } from "@/lib/classrooms/students";

/** Replaces the class's join code. Only its teacher can. */
export async function POST(
  _request: NextRequest,
  context: RouteContext<"/api/classrooms/[id]/join-code">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const id = parseId((await context.params).id, "Class");
    return NextResponse.json(await regenerateJoinCode(auth.supabase, id));
  } catch (error) {
    return errorResponse(error, "POST /api/classrooms/[id]/join-code");
  }
}
