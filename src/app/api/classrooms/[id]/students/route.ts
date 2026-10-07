import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, parseId, requireUser } from "@/lib/api/http";
import { AddStudentsRequest, addStudents } from "@/lib/classrooms/students";

/** Adds students to one of the signed-in teacher's classrooms, from a pasted list or a CSV. */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/classrooms/[id]/students">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const id = parseId((await context.params).id, "Class");
    const input = await parseBody(request, AddStudentsRequest);
    return NextResponse.json(await addStudents(auth.supabase, id, input));
  } catch (error) {
    return errorResponse(error, "POST /api/classrooms/[id]/students");
  }
}
