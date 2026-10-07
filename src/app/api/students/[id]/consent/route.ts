import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { recordSchoolConsent } from "@/lib/consent/service";

/** A student's teacher or school principal records that the school holds guardian consent. */
export async function POST(
  _request: NextRequest,
  context: RouteContext<"/api/students/[id]/consent">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const studentId = parseId((await context.params).id, "Student");
    await recordSchoolConsent(auth.supabase, studentId);
    return NextResponse.json({ recorded: true });
  } catch (error) {
    return errorResponse(error, "POST /api/students/[id]/consent");
  }
}
