import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, requireUser } from "@/lib/api/http";
import { CreateClassroomRequest, createClassroom } from "@/lib/classrooms/service";

/** Creates a classroom taught by the signed-in user. The database checks they teach in the school. */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const input = await parseBody(request, CreateClassroomRequest);
    return NextResponse.json(await createClassroom(auth.supabase, input), { status: 201 });
  } catch (error) {
    return errorResponse(error, "POST /api/classrooms");
  }
}
