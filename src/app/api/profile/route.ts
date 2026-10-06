import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, requireUser } from "@/lib/api/http";
import { saveProfile, SaveProfileInput } from "@/lib/profile/service";

/** Saves the signed-in learner's Render Profile. Self only (PRD 7.5). */
export async function PUT(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { profile } = await parseBody(request, SaveProfileInput);
    await saveProfile(auth.supabase, auth.user.id, profile);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return errorResponse(error, "PUT /api/profile");
  }
}
