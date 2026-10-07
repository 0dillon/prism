import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/api/http";
import { exportMyData } from "@/lib/consent/data-rights";
import { createAdminClient } from "@/lib/supabase/admin";

/** Downloads everything Prism holds about the signed-in person, as JSON. */
export async function GET() {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const data = await exportMyData(auth.supabase, createAdminClient(), auth.user.id);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="prism-my-data-${data.exportedAt.slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, "GET /api/account/export");
  }
}
