import { NextResponse, type NextRequest } from "next/server";
import { errorResponse, parseId, requireUser } from "@/lib/api/http";
import { classroomsToCsv } from "@/lib/admin/csv";
import { loadDashboard } from "@/lib/admin/dashboard";
import { currentFilters } from "@/lib/admin/filters";
import { logger } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Downloads the principal's classroom table as CSV, with the same filters as the page. It has
 * no layout or profile data, and each download is written to the audit log.
 */
export async function GET(request: NextRequest, context: RouteContext<"/api/orgs/[id]/export">) {
  const auth = await requireUser();
  if (!auth.ok) return auth.response;
  try {
    const orgId = parseId((await context.params).id, "School");
    const { filters } = currentFilters(Object.fromEntries(request.nextUrl.searchParams));
    // Loading the dashboard as the user is the permission check: only a principal gets rows.
    const dashboard = await loadDashboard(auth.supabase, orgId, filters);

    const audit = await createAdminClient()
      .from("audit_log")
      .insert({
        org_id: orgId,
        actor_id: auth.user.id,
        action: "export.classes",
        target: orgId,
        metadata: {
          rows: dashboard.rows.length,
          from: filters.from,
          to: filters.to,
          grade: filters.grade,
          subject: filters.subject,
          filteredByTeacher: filters.teacherId !== null,
        },
      });
    if (audit.error) logger.warn("could not record an export", { error: audit.error.message });

    return new NextResponse(classroomsToCsv(dashboard.rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="classes-${filters.from}-to-${filters.to}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error, "GET /api/orgs/[id]/export");
  }
}
