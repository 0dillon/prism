import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import type { DashboardFilters } from "./filters";

/**
 * What the principal's dashboard shows (PRD 5.8, P6-10 to P6-14). Everything comes from the
 * dashboard views and functions, which return only the principal's own organization and carry
 * no per-learner layout or profile. Layout appears only as organization-wide counts with
 * groups under five left out.
 */

export const LAYOUTS = ["reader", "cards", "conversation", "visual"] as const;
export type LayoutName = (typeof LAYOUTS)[number];

/** A group smaller than this is never shown (PRD 5.8). */
export const MIN_GROUP_SIZE = 5;

export interface ClassroomRow {
  classroomId: string;
  name: string;
  teacherId: string;
  teacherName: string;
  grade: string | null;
  subject: string | null;
  students: number;
  assignedLessons: number;
  /** Share of (student, lesson) pairs that are finished, from 0 to 1. */
  completion: number;
  /** Average share of ideas mastered, from 0 to 1. */
  averageMastery: number;
  /** Students active in the date range. */
  activeLearners: number;
  /** Time on task in the date range, in whole seconds. */
  activeSeconds: number;
}

export interface WeeklyPoint {
  weekStart: string;
  activeLearners: number;
  activeSeconds: number;
  masteredIdeas: number;
}

export interface LayoutShare {
  layout: LayoutName;
  /** Null when the group has fewer than five learners. */
  learners: number | null;
  share: number | null;
}

export interface FilterOptions {
  grades: string[];
  subjects: string[];
  teachers: { id: string; name: string }[];
}

export interface Dashboard {
  orgName: string;
  rows: ClassroomRow[];
  options: FilterOptions;
  weekly: WeeklyPoint[];
  layouts: LayoutShare[];
}

const fail = (what: string, message: string): never => {
  logger.error("could not load the school dashboard", { what, error: message });
  throw new ServiceError(500, "read_failed", "We could not load the dashboard. Please try again.");
};

export async function loadDashboard(
  user: UserClient,
  orgId: string,
  filters: DashboardFilters,
): Promise<Dashboard> {
  const [org, summary, classrooms, activity, weekly, layouts] = await Promise.all([
    user.from("organizations").select("name").eq("id", orgId).maybeSingle(),
    user.from("v_org_classroom_summary").select("*").eq("org_id", orgId),
    user
      .from("classrooms")
      .select("id, grade, subject")
      .eq("org_id", orgId)
      .is("archived_at", null),
    user.rpc("org_classroom_activity", { p_org: orgId, p_from: filters.from, p_to: filters.to }),
    user.rpc("org_weekly_activity", { p_org: orgId, p_from: filters.from, p_to: filters.to }),
    user.from("v_org_layout_usage").select("layout, learners, share").eq("org_id", orgId),
  ]);

  // Only the principal can call the activity functions; anyone else is told it does not exist.
  if (activity.error?.code === "42501" || weekly.error?.code === "42501" || !org.data) {
    throw new ServiceError(404, "not_found", "School not found.");
  }
  for (const [what, result] of [
    ["summary", summary],
    ["classrooms", classrooms],
    ["activity", activity],
    ["weekly", weekly],
    ["layouts", layouts],
  ] as const) {
    if (result.error) fail(what, result.error.message);
  }

  const classroomInfo = new Map((classrooms.data ?? []).map((c) => [c.id, c]));
  const activityBy = new Map((activity.data ?? []).map((a) => [a.classroom_id, a]));

  const teacherIds = [...new Set((summary.data ?? []).map((s) => s.teacher_id).filter(isString))];
  const names = new Map<string, string>();
  if (teacherIds.length > 0) {
    const { data } = await user
      .from("users_public")
      .select("id, display_name")
      .in("id", teacherIds);
    for (const row of data ?? []) names.set(row.id, row.display_name.trim());
  }
  let unnamed = 0;
  const teacherName = (id: string) => {
    const known = names.get(id);
    if (known) return known;
    names.set(id, `Teacher ${++unnamed}`);
    return names.get(id)!;
  };

  const all: ClassroomRow[] = (summary.data ?? [])
    .filter((s) => s.classroom_id && s.teacher_id)
    .map((s) => {
      const info = classroomInfo.get(s.classroom_id!);
      const act = activityBy.get(s.classroom_id!);
      return {
        classroomId: s.classroom_id!,
        name: s.classroom_name ?? "Untitled class",
        teacherId: s.teacher_id!,
        teacherName: teacherName(s.teacher_id!),
        grade: info?.grade ?? null,
        subject: info?.subject ?? null,
        students: s.students ?? 0,
        assignedLessons: s.assigned_lessons ?? 0,
        completion: Number(s.completion ?? 0),
        averageMastery: Number(s.average_mastery ?? 0),
        activeLearners: act?.active_learners ?? 0,
        activeSeconds: act?.active_seconds ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const options: FilterOptions = {
    grades: uniqueSorted(all.map((r) => r.grade)),
    subjects: uniqueSorted(all.map((r) => r.subject)),
    teachers: [...new Map(all.map((r) => [r.teacherId, r.teacherName])).entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };

  return {
    orgName: org.data.name,
    rows: applyFilters(all, filters),
    options,
    weekly: (weekly.data ?? []).map((w) => ({
      weekStart: w.week_start,
      activeLearners: w.active_learners,
      activeSeconds: w.active_seconds,
      masteredIdeas: w.mastered_ideas,
    })),
    layouts: layoutShares(layouts.data ?? []),
  };
}

const isString = (v: string | null): v is string => typeof v === "string";

function uniqueSorted(values: (string | null)[]): string[] {
  return [...new Set(values.filter(isString))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

export function applyFilters(rows: ClassroomRow[], filters: DashboardFilters): ClassroomRow[] {
  return rows.filter(
    (r) =>
      (!filters.grade || r.grade === filters.grade) &&
      (!filters.subject || r.subject === filters.subject) &&
      (!filters.teacherId || r.teacherId === filters.teacherId),
  );
}

/**
 * All four layouts, in a fixed order. The database leaves out any group with fewer than five
 * learners, so a layout that is missing is shown as "fewer than 5" and nothing more: it may
 * have no learners or a few, and which is not revealed. A group is also dropped here if the
 * database ever returned one that is too small, as a second guard.
 */
export function layoutShares(
  rows: { layout: string | null; learners: number | null; share: number | string | null }[],
): LayoutShare[] {
  const shown = new Map<string, { learners: number; share: number }>();
  for (const row of rows) {
    if (row.layout && row.learners !== null && row.learners >= MIN_GROUP_SIZE) {
      shown.set(row.layout, { learners: row.learners, share: Number(row.share ?? 0) });
    }
  }
  return LAYOUTS.map((layout) => {
    const hit = shown.get(layout);
    return { layout, learners: hit?.learners ?? null, share: hit?.share ?? null };
  });
}
