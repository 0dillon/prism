import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, parseId, requireUser } from "@/lib/api/http";
import { SetSpendCapRequest, setSpendCap } from "@/lib/orgs/spend";

/** Sets, changes or removes the school's monthly AI spend limit. Principal only. */
export async function PUT(request: NextRequest, context: RouteContext<"/api/orgs/[id]/spend-cap">) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const orgId = parseId((await context.params).id, "School");
    const { capUsd } = await parseBody(request, SetSpendCapRequest);
    return NextResponse.json(await setSpendCap(auth.supabase, orgId, capUsd));
  } catch (error) {
    return errorResponse(error, "PUT /api/orgs/[id]/spend-cap");
  }
}
