import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseBody, requireUser } from "@/lib/api/http";
import { getOrCreateVariant, VariantRequest } from "@/lib/lessons/variant-service";
import { createAdminClient } from "@/lib/supabase/admin";

/** Returns a reading-level variant of a concept, generating it once if needed (PRD 5.5, 7.5). */
export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;

  try {
    const input = await parseBody(request, VariantRequest);
    const variant = await getOrCreateVariant(
      { user: auth.supabase, admin: createAdminClient() },
      input,
    );
    return NextResponse.json(variant);
  } catch (error) {
    return errorResponse(error, "POST /api/variants");
  }
}
