import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, parseId, requireUser } from "@/lib/api/http";
import { UpdateClassroomRequest, updateClassroom } from "@/lib/classrooms/service";

/** Edits or archives one of the signed-in teacher's classrooms. */
export async function PATCH(request: NextRequest, context: RouteContext<"/api/classrooms/[id]">) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const id = parseId((await context.params).id, "Class");
    const input = await parseBody(request, UpdateClassroomRequest);
    return NextResponse.json(await updateClassroom(auth.supabase, auth.user.id, id, input));
  } catch (error) {
    return errorResponse(error, "PATCH /api/classrooms/[id]");
  }
}
