import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, parseId, requireUser } from "@/lib/api/http";
import { saveReviewedGraph, SaveGraphInput } from "@/lib/lessons/review-service";

/** Saves a teacher's review edits to a lesson's draft Knowledge Graph (PRD 7.5). */
export async function PATCH(
  request: NextRequest,
  context: RouteContext<"/api/lessons/[id]/graph">,
) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const input = await parseBody(request, SaveGraphInput);
    const saved = await saveReviewedGraph(auth.supabase, auth.user.id, parseId(id), input);
    return NextResponse.json(saved);
  } catch (error) {
    return errorResponse(error, "PATCH /api/lessons/[id]/graph");
  }
}
