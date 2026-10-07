import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, requireUser } from "@/lib/api/http";
import {
  AssignRequest,
  UnassignRequest,
  assignLesson,
  unassignLesson,
} from "@/lib/assignments/service";

/** Assigns one of the signed-in teacher's published lessons to some of their classes. */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const input = await parseBody(request, AssignRequest);
    return NextResponse.json(await assignLesson(auth.supabase, auth.user.id, input));
  } catch (error) {
    return errorResponse(error, "POST /api/assignments");
  }
}

/** Takes a lesson away from one class. Students keep their progress. */
export async function DELETE(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const input = await parseBody(request, UnassignRequest);
    await unassignLesson(auth.supabase, auth.user.id, input);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "DELETE /api/assignments");
  }
}
