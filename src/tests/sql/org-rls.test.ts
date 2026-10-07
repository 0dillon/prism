import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let principal: string;
let teacherA: string;
let teacherB: string;
let student: string;
let outsider: string;
let orgId: string;
let otherOrgId: string;
let roomA: string;
let roomB: string;
let lessonA: string;

const RLS = /row-level security/;
const DENIED = /permission denied/;

beforeAll(async () => {
  db = await createDb();
  principal = await createUser(db, "principal");
  teacherA = await createUser(db, "teacher_a");
  teacherB = await createUser(db, "teacher_b");
  student = await createUser(db, "student");
  outsider = await createUser(db, "outsider");

  const one = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ id: string }>(sql, params)).rows[0].id;

  orgId = await one(`insert into organizations (name, slug) values ('Oak', 'oak') returning id`);
  otherOrgId = await one(
    `insert into organizations (name, slug) values ('Elm', 'elm') returning id`,
  );
  await db.query(
    `insert into org_memberships (org_id, user_id, role) values
       ($1, $2, 'principal'), ($1, $3, 'teacher'), ($1, $4, 'teacher'), ($1, $5, 'student'),
       ($6, $7, 'teacher')`,
    [orgId, principal, teacherA, teacherB, student, otherOrgId, outsider],
  );
  const room = (org: string, teacher: string, name: string, code: string) =>
    one(
      `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, $3, $4) returning id`,
      [org, teacher, name, code],
    );
  roomA = await room(orgId, teacherA, "Year 5 A", "AAAAAA");
  roomB = await room(orgId, teacherB, "Year 5 B", "BBBBBB");
  await room(otherOrgId, outsider, "Elm 1", "CCCCCC");
  await db.query(`insert into enrollments (classroom_id, student_id) values ($1, $2)`, [
    roomA,
    student,
  ]);
  lessonA = await one(
    `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', 'published', 1) returning id`,
    [teacherA],
  );
  await db.query(`insert into assignments (classroom_id, lesson_id) values ($1, $2)`, [
    roomA,
    lessonA,
  ]);
  await db.query(
    `insert into audit_log (org_id, actor_id, action) values ($1, $2, 'org.created')`,
    [orgId, principal],
  );
});

afterAll(async () => {
  await db.close();
});

const names = (rows: { name: string }[]) => rows.map((r) => r.name).sort();
const count = (user: string, table: string) =>
  asUser(db, user, (tx) => tx.query<{ n: number }>(`select count(*)::int n from ${table}`)).then(
    (r) => r.rows[0].n,
  );

describe("classrooms", () => {
  it("lets a teacher read only their own classrooms", async () => {
    const rows = await asUser(db, teacherA, (tx) =>
      tx.query<{ name: string }>(`select name from classrooms`),
    );
    expect(names(rows.rows)).toEqual(["Year 5 A"]);
  });

  it("lets a principal read every classroom in their organization, and no other", async () => {
    const rows = await asUser(db, principal, (tx) =>
      tx.query<{ name: string }>(`select name from classrooms`),
    );
    expect(names(rows.rows)).toEqual(["Year 5 A", "Year 5 B"]);
  });

  it("lets an enrolled student see their classroom and no other", async () => {
    const rows = await asUser(db, student, (tx) =>
      tx.query<{ name: string }>(`select name from classrooms`),
    );
    expect(names(rows.rows)).toEqual(["Year 5 A"]);
  });

  it("keeps one organization's classrooms out of another's view", async () => {
    const rows = await asUser(db, outsider, (tx) =>
      tx.query<{ name: string }>(`select name from classrooms`),
    );
    expect(names(rows.rows)).toEqual(["Elm 1"]);
  });

  it("does not let a teacher change another teacher's classroom", async () => {
    const updated = await asUser(db, teacherB, (tx) =>
      tx.query(`update classrooms set name = 'Mine' where id = $1`, [roomA]),
    );
    expect(updated.affectedRows).toBe(0);
  });

  it("rejects a malformed join code", async () => {
    await expect(
      asService(db, (tx) =>
        tx.query(
          `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, 'X', 'abc')`,
          [orgId, teacherA],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("enrollments and assignments", () => {
  it("lets the teacher and principal see the roster, and the student only themselves", async () => {
    expect(await count(teacherA, "enrollments")).toBe(1);
    expect(await count(principal, "enrollments")).toBe(1);
    expect(await count(student, "enrollments")).toBe(1);
    expect(await count(teacherB, "enrollments")).toBe(0);
  });

  it("lets only the classroom's teacher enroll students", async () => {
    await expect(
      asUser(db, teacherB, (tx) =>
        tx.query(`insert into enrollments (classroom_id, student_id) values ($1, $2)`, [
          roomA,
          outsider,
        ]),
      ),
    ).rejects.toThrow(RLS);
    await expect(
      asUser(db, student, (tx) =>
        tx.query(`insert into enrollments (classroom_id, student_id) values ($1, $2)`, [
          roomB,
          student,
        ]),
      ),
    ).rejects.toThrow(RLS);
  });

  it("shows assignments to the teacher, principal and enrolled students only", async () => {
    expect(await count(teacherA, "assignments")).toBe(1);
    expect(await count(principal, "assignments")).toBe(1);
    expect(await count(student, "assignments")).toBe(1);
    expect(await count(teacherB, "assignments")).toBe(0);
    expect(await count(outsider, "assignments")).toBe(0);
  });

  it("lets a teacher assign only a lesson they own", async () => {
    const theirs = await asService(db, (tx) =>
      tx
        .query<{ id: string }>(
          `insert into lessons (owner_id, title, status, graph_version) values ($1, 'B', 'published', 1) returning id`,
          [teacherB],
        )
        .then((r) => r.rows[0].id),
    );
    await expect(
      asUser(db, teacherA, (tx) =>
        tx.query(`insert into assignments (classroom_id, lesson_id) values ($1, $2)`, [
          roomA,
          theirs,
        ]),
      ),
    ).rejects.toThrow(RLS);
  });

  it("lets a teacher change a due date by assigning again", async () => {
    const result = await asUser(db, teacherA, (tx) =>
      tx.query(
        `insert into assignments (classroom_id, lesson_id, due_at) values ($1, $2, '2026-11-01T23:59:59Z')
         on conflict (classroom_id, lesson_id) do update set due_at = excluded.due_at`,
        [roomA, lessonA],
      ),
    );
    expect(result.affectedRows).toBe(1);
    const row = await db.query<{ due_at: Date }>(
      `select due_at from assignments where classroom_id = $1`,
      [roomA],
    );
    expect(row.rows[0].due_at.toISOString()).toBe("2026-11-01T23:59:59.000Z");
    await db.query(`update assignments set due_at = null where classroom_id = $1`, [roomA]);
  });

  it("lets a teacher take a lesson away from their own class only", async () => {
    const other = await asUser(db, teacherB, (tx) =>
      tx.query(`delete from assignments where classroom_id = $1`, [roomA]),
    );
    expect(other.affectedRows).toBe(0);
  });

  it("does not assign the same lesson to a classroom twice", async () => {
    await expect(
      asUser(db, teacherA, (tx) =>
        tx.query(`insert into assignments (classroom_id, lesson_id) values ($1, $2)`, [
          roomA,
          lessonA,
        ]),
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("organizations, memberships and the audit log", () => {
  it("shows an organization only to its members", async () => {
    const rows = await asUser(db, teacherA, (tx) =>
      tx.query<{ name: string }>(`select name from organizations`),
    );
    expect(names(rows.rows)).toEqual(["Oak"]);
  });

  it("lets the principal see all memberships and a teacher only their own", async () => {
    expect(await count(principal, "org_memberships")).toBe(4);
    expect(await count(teacherA, "org_memberships")).toBe(1);
  });

  it("lets only the principal change the organization", async () => {
    const byTeacher = await asUser(db, teacherA, (tx) =>
      tx.query(`update organizations set name = 'Hacked' where id = $1`, [orgId]),
    );
    expect(byTeacher.affectedRows).toBe(0);
    const byPrincipal = await asUser(db, principal, (tx) =>
      tx.query(`update organizations set monthly_spend_cap_usd = 50 where id = $1`, [orgId]),
    );
    expect(byPrincipal.affectedRows).toBe(1);
  });

  it("refuses client writes to memberships and the audit log", async () => {
    await expect(
      asUser(db, teacherA, (tx) =>
        tx.query(
          `insert into org_memberships (org_id, user_id, role) values ($1, $2, 'principal')`,
          [orgId, teacherA],
        ),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      asUser(db, principal, (tx) =>
        tx.query(`insert into audit_log (org_id, action) values ($1, 'x')`, [orgId]),
      ),
    ).rejects.toThrow(DENIED);
  });

  it("shows the audit log to the principal only", async () => {
    expect(await count(principal, "audit_log")).toBe(1);
    expect(await count(teacherA, "audit_log")).toBe(0);
    expect(await count(student, "audit_log")).toBe(0);
  });
});
