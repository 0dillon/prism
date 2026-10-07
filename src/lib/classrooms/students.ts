import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * Adding students to a classroom (PRD 5.8, P6-04) by pasted list, CSV file or join code. The
 * list and the file are checked here, so the teacher gets a report of the rows that could not
 * be used; the valid addresses go to the database in one call.
 */

export const MAX_STUDENTS_PER_ADD = 500;
const MAX_CSV_CHARACTERS = 200_000;

export interface RejectedRow {
  /** The line in the pasted text or file, counting from 1. Null when the position is unknown. */
  line: number | null;
  value: string;
  reason: string;
}

const EmailCheck = z.email();
const isEmail = (value: string) => value.length <= 320 && EmailCheck.safeParse(value).success;

/** Splits a pasted list on commas, semicolons, spaces and line breaks. */
export function parseEmailList(text: string): { emails: string[]; rejected: RejectedRow[] } {
  const emails: string[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const piece of lineText.split(/[\s,;]+/)) {
      const value = piece.trim().replace(/^<|>$/g, "");
      if (!value) continue;
      collect(value, index + 1, emails, rejected, seen);
    }
  });
  return { emails, rejected };
}

function collect(
  value: string,
  line: number,
  emails: string[],
  rejected: RejectedRow[],
  seen: Set<string>,
) {
  const email = value.toLowerCase();
  if (!isEmail(email)) {
    rejected.push({ line, value, reason: "This is not a valid email address." });
  } else if (seen.has(email)) {
    rejected.push({ line, value, reason: "This address is listed more than once." });
  } else {
    seen.add(email);
    emails.push(email);
  }
}

/** Reads CSV into rows of cells. Handles quotes, doubled quotes, commas and line breaks inside quotes. */
export function parseCsvRows(text: string): { line: number; cells: string[] }[] {
  const rows: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const input = text.replace(/^﻿/, "");
  const endRow = () => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) rows.push({ line: rowLine, cells });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") {
      quoted = true;
    } else if (ch === "," || ch === ";") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || cells.length > 0) endRow();
  return rows;
}

/**
 * Finds the email in each row of a CSV. A first row with no address in it is a header: the
 * column named like "email" is used, or the only column if there is just one. Without a
 * header the first column is used.
 */
export function parseStudentCsv(text: string): { emails: string[]; rejected: RejectedRow[] } {
  const emails: string[] = [];
  const rejected: RejectedRow[] = [];
  const seen = new Set<string>();
  if (text.length > MAX_CSV_CHARACTERS) {
    return { emails, rejected: [{ line: null, value: "", reason: "This file is too large." }] };
  }
  let rows = parseCsvRows(text);
  if (rows.length === 0) {
    return { emails, rejected: [{ line: null, value: "", reason: "The file has no rows." }] };
  }

  let column = 0;
  const first = rows[0];
  if (!first.cells.some((c) => c.includes("@"))) {
    const named = first.cells.findIndex((c) => /^\s*e-?mail(\s*address)?\s*$/i.test(c));
    if (named >= 0) column = named;
    else if (first.cells.length > 1) {
      return {
        emails,
        rejected: [
          {
            line: first.line,
            value: first.cells.join(", "),
            reason: "There is no column named email.",
          },
        ],
      };
    }
    rows = rows.slice(1);
  }

  if (rows.length > MAX_STUDENTS_PER_ADD) {
    return {
      emails,
      rejected: [
        {
          line: null,
          value: "",
          reason: `Add at most ${MAX_STUDENTS_PER_ADD} students at a time.`,
        },
      ],
    };
  }

  for (const row of rows) {
    const value = (row.cells[column] ?? "").trim();
    if (!value) {
      rejected.push({ line: row.line, value: "", reason: "This row has no email address." });
      continue;
    }
    collect(value, row.line, emails, rejected, seen);
  }
  return { emails, rejected };
}

export const AddStudentsRequest = z
  .object({
    emails: z.string().max(MAX_CSV_CHARACTERS).optional(),
    csv: z
      .string()
      .max(MAX_CSV_CHARACTERS + 1)
      .optional(),
  })
  .refine((v) => v.emails !== undefined || v.csv !== undefined, "Add some email addresses.");

export interface AddStudentsReport {
  added: number;
  already: number;
  rejected: RejectedRow[];
}

export async function addStudents(
  user: UserClient,
  classroomId: string,
  input: { emails?: string; csv?: string },
): Promise<AddStudentsReport> {
  const parsed =
    input.csv !== undefined ? parseStudentCsv(input.csv) : parseEmailList(input.emails ?? "");
  if (parsed.emails.length > MAX_STUDENTS_PER_ADD) {
    throw new ServiceError(
      400,
      "too_many",
      `Add at most ${MAX_STUDENTS_PER_ADD} students at a time.`,
    );
  }
  if (parsed.emails.length === 0) {
    return { added: 0, already: 0, rejected: parsed.rejected };
  }

  const { data, error } = await user.rpc("add_students_by_email", {
    p_classroom: classroomId,
    p_emails: parsed.emails,
  });
  if (error || !data) {
    if (error?.code === "42501") {
      throw new ServiceError(404, "not_found", "Class not found.");
    }
    if (error?.code === "P0001") {
      throw new ServiceError(
        409,
        "archived",
        "This class is archived. Restore it to add students.",
      );
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not add students", { error: error?.message });
    throw new ServiceError(500, "add_failed", "We could not add the students. Please try again.");
  }
  return {
    added: data.filter((r) => r.outcome === "added").length,
    already: data.filter((r) => r.outcome === "already").length,
    rejected: parsed.rejected,
  };
}

export const JoinClassRequest = z.object({
  code: z.string().trim().min(1, "Enter the class code.").max(20, "That code is too long."),
});

/** A student joins a class with its code. */
export async function joinClassroom(
  user: UserClient,
  code: string,
): Promise<{ classroomId: string }> {
  const { data, error } = await user.rpc("join_classroom", { p_code: code });
  if (error || !data) {
    if (error?.code === "P0002") {
      throw new ServiceError(
        404,
        "code_not_found",
        "We could not find a class with that code. Check it with your teacher.",
      );
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not join a classroom", { error: error?.message });
    throw new ServiceError(
      500,
      "join_failed",
      "We could not add you to the class. Please try again.",
    );
  }
  return { classroomId: data };
}

/** Replaces a class code that has been shared too widely. Only the class's teacher may. */
export async function regenerateJoinCode(
  user: UserClient,
  classroomId: string,
): Promise<{ joinCode: string }> {
  const { data, error } = await user.rpc("regenerate_join_code", { p_classroom: classroomId });
  if (error || !data) {
    if (error?.code === "42501") throw new ServiceError(404, "not_found", "Class not found.");
    logger.error("could not replace a join code", { error: error?.message });
    throw new ServiceError(500, "code_failed", "We could not make a new code. Please try again.");
  }
  return { joinCode: data };
}

export interface RosterEntry {
  studentId: string;
  name: string;
}

/** The students in a class and their waiting invitations count, for the teacher's roster. */
export async function loadRoster(
  user: UserClient,
  classroomId: string,
): Promise<{ students: RosterEntry[]; pending: number }> {
  const [enrolled, pending] = await Promise.all([
    user.from("enrollments").select("student_id").eq("classroom_id", classroomId),
    user.from("pending_enrollments").select("email").eq("classroom_id", classroomId),
  ]);
  const ids = (enrolled.data ?? []).map((e) => e.student_id);
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await user.from("users_public").select("id, display_name").in("id", ids);
    for (const row of data ?? []) names.set(row.id, row.display_name.trim());
  }
  const students = ids
    .map((id, index) => ({ studentId: id, name: names.get(id) || `Student ${index + 1}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { students, pending: (pending.data ?? []).length };
}
