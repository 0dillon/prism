import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, requireUser } from "@/lib/api/http";
import { SharingRequest, setProfileSharing } from "@/lib/profile/sharing";

/** Turns sharing of the signed-in learner's settings with their teachers on or off. */
export async function PUT(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const { share } = await parseBody(request, SharingRequest);
    return NextResponse.json(await setProfileSharing(auth.supabase, share));
  } catch (error) {
    return errorResponse(error, "PUT /api/profile/sharing");
  }
}
