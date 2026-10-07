import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/api/http";
import { requestDeletion } from "@/lib/consent/data-rights";

/** Asks for the signed-in person's account and records to be deleted. */
export async function POST() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await requestDeletion(auth.supabase, auth.user.id), { status: 202 });
  } catch (error) {
    return errorResponse(error, "POST /api/account/deletion");
  }
}
