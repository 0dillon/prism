import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, requireUser } from "@/lib/api/http";
import { createLesson, CreateLessonInput } from "@/lib/lessons/service";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Creates a lesson and returns a signed URL for uploading its source file directly to
 * storage (PRD 5.1 step 1). The file never passes through this server.
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const input = await parseBody(request, CreateLessonInput);
    const created = await createLesson(
      { user: auth.supabase, admin: createAdminClient() },
      auth.user.id,
      input,
    );
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    return errorResponse(error, "POST /api/lessons");
  }
}
