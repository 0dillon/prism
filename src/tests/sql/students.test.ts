import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let teacher: string;
let otherTeacher: string;
let principal: string;
let ann: string;
let ben: string;
let orgId: string;
let room: string;
let code: string;

beforeAll(async () => {
  db = await createDb();
  teacher = await createUser(db, "teacher");
  otherTeacher = await createUser(db, "other_teacher");
  principal = await createUser(db, "principal");
  ann = await createUser(db, "ann");
  ben = await createUser(db, "ben");
  orgId = (
    await db.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Oak', 'oak') returning id`,
    )
  ).rows[0].id;
  await db.query(
    `insert into org_memberships (org_id, user_id, role)
     values ($1, $2, 'teacher'), ($1, $3, 'teacher'), ($1, $4, 'principal')`,
    [orgId, teacher, otherTeacher, principal],
  );
  room = await asUser(
    db,
    teacher,
    async (tx) =>
      (
        await tx.query<{ id: string }>(`select public.create_classroom($1, 'Year 5') as id`, [
          orgId,
        ])
      ).rows[0].id,
  );
  code = (
    await db.query<{ join_code: string }>(`select join_code from classrooms where id = $1`, [room])
  ).rows[0].join_code;
});

afterAll(async () => {
  await db.close();
});

const add = (user: string, emails: string[], classroom = room) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<{ student_email: string; outcome: string }>(
          `select * from public.add_students_by_email($1, $2)`,
          [classroom, emails],
        )
      ).rows,
  );

const enrolled = async (classroom = room) =>
  (
    await db.query<{ email: string }>(
      `select u.email from enrollments e join auth.users u on u.id = e.student_id
       where e.classroom_id = $1 order by u.email`,
      [classroom],
    )
  ).rows.map((r) => r.email);

describe("add_students_by_email", () => {
  it("enrolls people who have accounts and makes them members of the school", async () => {
    const result = await add(teacher, ["ann@example.test", " BEN@example.test "]);
    expect(result).toEqual([
      { student_email: "ann@example.test", outcome: "added" },
      { student_email: "ben@example.test", outcome: "added" },
    ]);
    expect(await enrolled()).toEqual(["ann@example.test", "ben@example.test"]);
    const roles = await db.query(
      `select role from org_memberships where org_id = $1 and user_id = $2`,
      [orgId, ann],
    );
    expect(roles.rows).toEqual([{ role: "student" }]);
  });

  it("says 'already' for a student who is in the class, and counts each address once", async () => {
    const result = await add(teacher, ["ann@example.test", "ANN@example.test"]);
    expect(result).toEqual([{ student_email: "ann@example.test", outcome: "already" }]);
  });

  it("does not change the role of a teacher or principal who is added", async () => {
    await add(teacher, ["principal@example.test"]);
    const role = await db.query(
      `select role from org_memberships where org_id = $1 and user_id = $2`,
      [orgId, principal],
    );
    expect(role.rows).toEqual([{ role: "principal" }]);
  });

  it("keeps an address with no account as pending and reports it the same way", async () => {
    const result = await add(teacher, ["new.student@example.test"]);
    expect(result).toEqual([{ student_email: "new.student@example.test", outcome: "added" }]);
    expect(await enrolled()).not.toContain("new.student@example.test");
    const pending = await db.query(
      `select email from pending_enrollments where classroom_id = $1`,
      [room],
    );
    expect(pending.rows).toEqual([{ email: "new.student@example.test" }]);
    const again = await add(teacher, ["new.student@example.test"]);
    expect(again[0].outcome).toBe("already");
  });

  it("enrolls a pending student when they sign up with a confirmed email", async () => {
    const id = await createUser(db, "new.student");
    expect(await enrolled()).toContain("new.student@example.test");
    const left = await db.query(
      `select 1 from pending_enrollments where email = 'new.student@example.test'`,
    );
    expect(left.rows).toHaveLength(0);
    const role = await db.query(`select role from org_memberships where user_id = $1`, [id]);
    expect(role.rows).toEqual([{ role: "student" }]);
  });

  it("waits for confirmation when the address is not confirmed yet", async () => {
    await add(teacher, ["late@example.test"]);
    const id = await createUser(db, "late", { confirmed: false });
    expect(await enrolled()).not.toContain("late@example.test");
    await db.query(`update auth.users set email_confirmed_at = now() where id = $1`, [id]);
    expect(await enrolled()).toContain("late@example.test");
  });

  it("is limited to the classroom's own teacher", async () => {
    await expect(add(otherTeacher, ["ann@example.test"])).rejects.toThrow(
      /only the classroom teacher/,
    );
    await expect(add(ann, ["ben@example.test"])).rejects.toThrow(/only the classroom teacher/);
    await expect(
      asAnon(db, (tx) => tx.query(`select * from public.add_students_by_email($1, '{}')`, [room])),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses an archived class and more than 500 addresses", async () => {
    const archived = await asUser(
      db,
      teacher,
      async (tx) =>
        (await tx.query<{ id: string }>(`select public.create_classroom($1, 'Old') as id`, [orgId]))
          .rows[0].id,
    );
    await asUser(db, teacher, (tx) =>
      tx.query(`update classrooms set archived_at = now() where id = $1`, [archived]),
    );
    await expect(add(teacher, ["ann@example.test"], archived)).rejects.toThrow(/archived/);
    const many = Array.from({ length: 501 }, (_, i) => `s${i}@example.test`);
    await expect(add(teacher, many)).rejects.toThrow(/too many/);
  });

  it("records the add in the audit log", async () => {
    const log = await db.query(
      `select 1 from audit_log where action = 'classroom.students_added' and org_id = $1`,
      [orgId],
    );
    expect(log.rows.length).toBeGreaterThan(0);
  });
});

describe("join_classroom", () => {
  const join = (user: string, value: string) =>
    asUser(
      db,
      user,
      async (tx) =>
        (await tx.query<{ id: string }>(`select public.join_classroom($1) as id`, [value])).rows[0]
          .id,
    );

  it("enrolls the student, whatever the case or spacing of the code", async () => {
    const student = await createUser(db, "joiner");
    expect(await join(student, ` ${code.toLowerCase()} `)).toBe(room);
    expect(await enrolled()).toContain("joiner@example.test");
    const seen = await asUser(db, student, (tx) => tx.query(`select id from classrooms`));
    expect(seen.rows).toHaveLength(1);
  });

  it("is harmless to do twice", async () => {
    const student = await createUser(db, "joiner_twice");
    await join(student, code);
    await join(student, code);
    const n = await db.query(`select count(*)::int n from enrollments where student_id = $1`, [
      student,
    ]);
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it("refuses an unknown code and an archived class's code", async () => {
    const student = await createUser(db, "joiner_bad");
    await expect(join(student, "ZZZZZZ")).rejects.toThrow(/not found/);
    await expect(join(student, "")).rejects.toThrow(/not found/);
    const old = await db.query<{ join_code: string }>(
      `select join_code from classrooms where archived_at is not null limit 1`,
    );
    await expect(join(student, old.rows[0].join_code)).rejects.toThrow(/not found/);
  });

  it("is closed to people who are not signed in", async () => {
    await expect(
      asAnon(db, (tx) => tx.query(`select public.join_classroom($1)`, [code])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("pending enrollments", () => {
  it("are visible to the classroom's teacher and principal, and nobody else", async () => {
    const count = (user: string) =>
      asUser(db, user, (tx) =>
        tx.query<{ n: number }>(`select count(*)::int n from pending_enrollments`),
      ).then((r) => r.rows[0].n);
    await add(teacher, ["waiting@example.test"]);
    expect(await count(teacher)).toBeGreaterThan(0);
    expect(await count(principal)).toBeGreaterThan(0);
    expect(await count(otherTeacher)).toBe(0);
    expect(await count(ann)).toBe(0);
  });
});
