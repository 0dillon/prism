import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, parseId, requireUser } from "@/lib/api/http";
import { SignAction, updateSignLink } from "@/lib/lessons/sign-service";

/** Verifies, un-verifies or removes a proposed sign link for a lesson the caller owns. */
export async function POST(request: NextRequest, context: RouteContext<"/api/lessons/[id]/signs">) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const input = await parseBody(request, SignAction);
    const result = await updateSignLink(auth.supabase, auth.user.id, parseId(id), input);
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "POST /api/lessons/[id]/signs");
  }
}
