import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * Classrooms (PRD 5.8, P6-03). A teacher creates, edits and archives their own. Creation is
 * a database function so the join code is made there; edits go through row-level security,
 * which limits them to the teacher's own classrooms and to the descriptive columns.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : undefined));

export const CreateClassroomRequest = z.object({
  orgId: z.uuid(),
  name: z.string().trim().min(1, "Enter a name for the class.").max(200, "That name is too long."),
  grade: optionalText(40),
  subject: optionalText(80),
});
export interface CreateClassroomInput {
  orgId: string;
  name: string;
  grade?: string;
  subject?: string;
}

export const UpdateClassroomRequest = z
  .object({
    name: z.string().trim().min(1, "Enter a name for the class.").max(200),
    grade: z.string().trim().max(40).nullable(),
    subject: z.string().trim().max(80).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change.");
export type UpdateClassroomInput = z.infer<typeof UpdateClassroomRequest>;

export interface ClassroomSummary {
  id: string;
  orgId: string;
  name: string;
  grade: string | null;
  subject: string | null;
  joinCode: string;
  archived: boolean;
  students: number;
}

export async function createClassroom(user: UserClient, input: CreateClassroomInput) {
  const { data, error } = await user.rpc("create_classroom", {
    p_org: input.orgId,
    p_name: input.name,
    p_grade: input.grade,
    p_subject: input.subject,
  });
  if (error || !data) {
    if (error?.code === "42501") {
      throw new ServiceError(
        403,
        "forbidden",
        "You can only create classes in a school you teach in.",
      );
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not create a classroom", { error: error?.message });
    throw new ServiceError(
      500,
      "create_failed",
      "We could not create the class. Please try again.",
    );
  }
  return { id: data };
}

const COLUMNS = "id, org_id, name, grade, subject, join_code, archived_at";

/** The teacher's own classrooms, newest first, each with how many students it has. */
export async function listClassrooms(
  user: UserClient,
  userId: string,
  options: { archived?: boolean } = {},
): Promise<ClassroomSummary[]> {
  let query = user.from("classrooms").select(COLUMNS).eq("teacher_id", userId);
  query = options.archived ? query.not("archived_at", "is", null) : query.is("archived_at", null);
  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) {
    logger.error("could not list classrooms", { error: error.message });
    throw new ServiceError(500, "read_failed", "We could not load your classes. Please try again.");
  }
  const rows = data ?? [];
  const counts = await studentCounts(
    user,
    rows.map((r) => r.id),
  );
  return rows.map((r) => toSummary(r, counts.get(r.id) ?? 0));
}

export async function getClassroom(
  user: UserClient,
  userId: string,
  classroomId: string,
): Promise<ClassroomSummary> {
  const { data } = await user
    .from("classrooms")
    .select(COLUMNS)
    .eq("id", classroomId)
    .eq("teacher_id", userId)
    .maybeSingle();
  // Another teacher's classroom and one that does not exist look the same.
  if (!data) throw new ServiceError(404, "not_found", "Class not found.");
  const counts = await studentCounts(user, [data.id]);
  return toSummary(data, counts.get(data.id) ?? 0);
}

export async function updateClassroom(
  user: UserClient,
  userId: string,
  classroomId: string,
  input: UpdateClassroomInput,
): Promise<ClassroomSummary> {
  const patch: {
    name?: string;
    grade?: string | null;
    subject?: string | null;
    archived_at?: string | null;
  } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.grade !== undefined) patch.grade = input.grade || null;
  if (input.subject !== undefined) patch.subject = input.subject || null;
  if (input.archived !== undefined) {
    patch.archived_at = input.archived ? new Date().toISOString() : null;
  }
  const { data, error } = await user
    .from("classrooms")
    .update(patch)
    .eq("id", classroomId)
    .eq("teacher_id", userId)
    .select(COLUMNS);
  if (error) {
    logger.error("could not update a classroom", { error: error.message });
    throw new ServiceError(500, "update_failed", "We could not save the change. Please try again.");
  }
  const row = data?.[0];
  if (!row) throw new ServiceError(404, "not_found", "Class not found.");
  const counts = await studentCounts(user, [row.id]);
  return toSummary(row, counts.get(row.id) ?? 0);
}

async function studentCounts(user: UserClient, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;
  const { data } = await user.from("enrollments").select("classroom_id").in("classroom_id", ids);
  for (const row of data ?? []) {
    counts.set(row.classroom_id, (counts.get(row.classroom_id) ?? 0) + 1);
  }
  return counts;
}

function toSummary(
  row: {
    id: string;
    org_id: string;
    name: string;
    grade: string | null;
    subject: string | null;
    join_code: string;
    archived_at: string | null;
  },
  students: number,
): ClassroomSummary {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    grade: row.grade,
    subject: row.subject,
    joinCode: row.join_code,
    archived: row.archived_at !== null,
    students,
  };
}
