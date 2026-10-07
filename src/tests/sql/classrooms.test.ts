import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let principal: string;
let teacherA: string;
let teacherB: string;
let student: string;
let outsider: string;
let orgId: string;
let otherOrgId: string;

const RLS = /row-level security|only teachers/;
const DENIED = /permission denied/;

beforeAll(async () => {
  db = await createDb();
  principal = await createUser(db, "principal");
  teacherA = await createUser(db, "teacher_a");
  teacherB = await createUser(db, "teacher_b");
  student = await createUser(db, "student");
  outsider = await createUser(db, "outsider");
  const org = async (name: string, slug: string) =>
    (
      await db.query<{ id: string }>(
        `insert into organizations (name, slug) values ($1, $2) returning id`,
        [name, slug],
      )
    ).rows[0].id;
  orgId = await org("Oak", "oak");
  otherOrgId = await org("Elm", "elm");
  await db.query(
    `insert into org_memberships (org_id, user_id, role) values
       ($1, $2, 'principal'), ($1, $3, 'teacher'), ($1, $4, 'teacher'), ($1, $5, 'student'),
       ($6, $7, 'teacher')`,
    [orgId, principal, teacherA, teacherB, student, otherOrgId, outsider],
  );
});

afterAll(async () => {
  await db.close();
});

const create = (user: string, org: string, name = "Year 5", grade?: string, subject?: string) =>
  asUser(db, user, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `select public.create_classroom($1, $2, $3, $4) as id`,
      [org, name, grade ?? null, subject ?? null],
    );
    return rows[0].id;
  });

describe("create_classroom", () => {
  it("makes a classroom for the caller with a six-character code from a readable alphabet", async () => {
    const id = await create(teacherA, orgId, "  Year 5 A ", "5", " Science ");
    const row = await db.query<{
      name: string;
      teacher_id: string;
      grade: string;
      subject: string;
      join_code: string;
    }>(`select name, teacher_id, grade, subject, join_code from classrooms where id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({
      name: "Year 5 A",
      teacher_id: teacherA,
      grade: "5",
      subject: "Science",
    });
    expect(row.rows[0].join_code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it("gives every classroom its own code", async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, i) => create(teacherB, orgId, `C${i}`)),
    );
    const codes = await db.query<{ join_code: string }>(
      `select join_code from classrooms where id = any($1)`,
      [ids],
    );
    expect(new Set(codes.rows.map((r) => r.join_code)).size).toBe(12);
  });

  it("lets a principal teach a class too", async () => {
    await create(principal, orgId, "Principal's class");
  });

  it("refuses a student, and a teacher from another organization", async () => {
    await expect(create(student, orgId)).rejects.toThrow(RLS);
    await expect(create(outsider, orgId)).rejects.toThrow(RLS);
  });

  it("does not let a client insert or delete a classroom directly", async () => {
    await expect(
      asUser(db, teacherA, (tx) =>
        tx.query(
          `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, 'X', 'ZZZZZZ')`,
          [orgId, teacherA],
        ),
      ),
    ).rejects.toThrow(DENIED);
    await expect(asUser(db, teacherA, (tx) => tx.query(`delete from classrooms`))).rejects.toThrow(
      DENIED,
    );
  });
});

describe("editing and archiving", () => {
  let room: string;
  beforeAll(async () => {
    room = await create(teacherA, orgId, "Editable");
  });

  it("lets the teacher edit the description and archive", async () => {
    const edited = await asUser(db, teacherA, (tx) =>
      tx.query(`update classrooms set name = 'Renamed', grade = '6' where id = $1`, [room]),
    );
    expect(edited.affectedRows).toBe(1);
    const archived = await asUser(db, teacherA, (tx) =>
      tx.query(`update classrooms set archived_at = now() where id = $1`, [room]),
    );
    expect(archived.affectedRows).toBe(1);
    await asUser(db, teacherA, (tx) =>
      tx.query(`update classrooms set archived_at = null where id = $1`, [room]),
    );
  });

  it("does not let a teacher change the code, the owner or the organization by hand", async () => {
    for (const column of [
      "join_code = 'AAAAAA'",
      `teacher_id = '${teacherB}'`,
      `org_id = '${otherOrgId}'`,
    ]) {
      await expect(
        asUser(db, teacherA, (tx) =>
          tx.query(`update classrooms set ${column} where id = $1`, [room]),
        ),
      ).rejects.toThrow(DENIED);
    }
  });

  it("does not let another teacher edit it", async () => {
    const result = await asUser(db, teacherB, (tx) =>
      tx.query(`update classrooms set name = 'Mine' where id = $1`, [room]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it("replaces a join code only for the classroom's teacher", async () => {
    const before = (
      await db.query<{ join_code: string }>(`select join_code from classrooms where id = $1`, [
        room,
      ])
    ).rows[0].join_code;
    const code = await asUser(
      db,
      teacherA,
      async (tx) =>
        (await tx.query<{ c: string }>(`select public.regenerate_join_code($1) as c`, [room]))
          .rows[0].c,
    );
    expect(code).not.toBe(before);
    expect(
      (
        await db.query<{ join_code: string }>(`select join_code from classrooms where id = $1`, [
          room,
        ])
      ).rows[0].join_code,
    ).toBe(code);
    await expect(
      asUser(db, teacherB, (tx) => tx.query(`select public.regenerate_join_code($1)`, [room])),
    ).rejects.toThrow(/only the classroom teacher/);
  });
});

describe("archived classrooms in the organization views", () => {
  it("drop out of the principal's summary", async () => {
    const live = await create(teacherA, orgId, "Live");
    const old = await create(teacherA, orgId, "Old");
    await asUser(db, teacherA, (tx) =>
      tx.query(`update classrooms set archived_at = now() where id = $1`, [old]),
    );
    const rows = await asUser(db, principal, (tx) =>
      tx.query<{ classroom_id: string }>(`select classroom_id from v_org_classroom_summary`),
    );
    const ids = rows.rows.map((r) => r.classroom_id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(old);
  });
});
