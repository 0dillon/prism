import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let teacher: string;
let otherTeacher: string;
let principal: string;
let student: string;
let loner: string;
let stranger: string;
let orgId: string;
let room: string;

const PROFILE = { layout: "cards", preset: "hyper_focus" };

beforeAll(async () => {
  db = await createDb();
  teacher = await createUser(db, "teacher");
  otherTeacher = await createUser(db, "other_teacher");
  principal = await createUser(db, "principal");
  student = await createUser(db, "student");
  loner = await createUser(db, "loner");
  stranger = await createUser(db, "stranger");
  orgId = (
    await db.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Oak', 'oak') returning id`,
    )
  ).rows[0].id;
  await db.query(
    `insert into org_memberships (org_id, user_id, role)
     values ($1, $2, 'teacher'), ($1, $3, 'teacher'), ($1, $4, 'principal'), ($1, $5, 'student')`,
    [orgId, teacher, otherTeacher, principal, student],
  );
  room = (
    await db.query<{ id: string }>(
      `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, 'A', 'AAAAAA') returning id`,
      [orgId, teacher],
    )
  ).rows[0].id;
  await db.query(`insert into enrollments values ($1, $2)`, [room, student]);
  await db.query(`insert into render_profiles (user_id, profile) values ($1, $3), ($2, $3)`, [
    student,
    stranger,
    JSON.stringify(PROFILE),
  ]);
});

afterAll(async () => {
  await db.close();
});

const share = (user: string, value: boolean) =>
  asUser(
    db,
    user,
    async (tx) =>
      (await tx.query<{ r: boolean }>(`select public.set_profile_sharing($1) as r`, [value]))
        .rows[0].r,
  );

const shared = (user: string, classroom: string, studentId: string) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<{ p: unknown }>(`select public.get_shared_profile($1, $2) as p`, [
          classroom,
          studentId,
        ])
      ).rows[0].p,
  );

describe("get_shared_profile", () => {
  it("returns nothing while the student has not opted in, to anyone", async () => {
    expect(await shared(teacher, room, student)).toBeNull();
    expect(await shared(principal, room, student)).toBeNull();
  });

  it("returns the profile to the class's teacher and the principal once the student opts in", async () => {
    await share(student, true);
    expect(await shared(teacher, room, student)).toEqual(PROFILE);
    expect(await shared(principal, room, student)).toEqual(PROFILE);
  });

  it("still returns nothing to another teacher, to the student's classmates, or for a non-member", async () => {
    expect(await shared(otherTeacher, room, student)).toBeNull();
    expect(await shared(stranger, room, student)).toBeNull();
    // A student who opted in, but is not in this classroom, cannot be read through it.
    await share(stranger, true);
    expect(await shared(teacher, room, stranger)).toBeNull();
  });

  it("stops the moment the student opts out", async () => {
    await share(student, false);
    expect(await shared(teacher, room, student)).toBeNull();
  });

  it("is closed to people who are not signed in", async () => {
    await expect(
      asAnon(db, (tx) => tx.query(`select public.get_shared_profile($1, $2)`, [room, student])),
    ).rejects.toThrow(/permission denied/);
  });

  it("is the only way in: a teacher cannot select the profile table", async () => {
    const rows = await asUser(db, teacher, (tx) => tx.query(`select * from render_profiles`));
    expect(rows.rows).toHaveLength(0);
  });
});

describe("set_profile_sharing", () => {
  it("is off by default", async () => {
    const row = await db.query<{ share_with_teachers: boolean }>(
      `select share_with_teachers from render_profiles where user_id = $1`,
      [loner],
    );
    expect(row.rows).toEqual([]);
  });

  it("changes the flag and writes one audit entry for each school the student is in", async () => {
    const before = (
      await db.query(`select 1 from audit_log where action = 'profile_sharing.changed'`)
    ).rows.length;
    expect(await share(student, true)).toBe(true);
    const flag = await db.query(
      `select share_with_teachers from render_profiles where user_id = $1`,
      [student],
    );
    expect(flag.rows).toEqual([{ share_with_teachers: true }]);
    const log = await db.query<{
      org_id: string;
      actor_id: string;
      target: string;
      metadata: unknown;
    }>(
      `select org_id, actor_id, target, metadata from audit_log
       where action = 'profile_sharing.changed' and actor_id = $1 order by created_at desc limit 1`,
      [student],
    );
    expect(log.rows[0]).toEqual({
      org_id: orgId,
      actor_id: student,
      target: student,
      metadata: { shared: true },
    });
    expect(
      (await db.query(`select 1 from audit_log where action = 'profile_sharing.changed'`)).rows
        .length,
    ).toBeGreaterThan(before);
  });

  it("holds no settings in the audit entry", async () => {
    const log = await db.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_log where action = 'profile_sharing.changed'`,
    );
    for (const row of log.rows) expect(Object.keys(row.metadata)).toEqual(["shared"]);
  });

  it("writes nothing when the choice has not changed", async () => {
    await share(student, true);
    const count = async () =>
      (
        await db.query<{ n: number }>(`select count(*)::int n from audit_log where actor_id = $1`, [
          student,
        ])
      ).rows[0].n;
    const before = await count();
    await share(student, true);
    expect(await count()).toBe(before);
  });

  it("logs a student who is in no school, without a school on the entry", async () => {
    await share(stranger, false);
    await share(stranger, true);
    const log = await db.query<{ org_id: string | null }>(
      `select org_id from audit_log where actor_id = $1 and action = 'profile_sharing.changed'`,
      [stranger],
    );
    expect(log.rows.length).toBeGreaterThan(0);
    expect(log.rows.every((r) => r.org_id === null)).toBe(true);
  });

  it("asks a student with no saved settings to save them first", async () => {
    await expect(share(loner, true)).rejects.toThrow(/save your settings/);
  });

  it("is shown to the school's principal in its audit log, and to no one else", async () => {
    const n = (user: string) =>
      asUser(db, user, (tx) =>
        tx.query<{ n: number }>(
          `select count(*)::int n from audit_log where action = 'profile_sharing.changed'`,
        ),
      ).then((r) => r.rows[0].n);
    expect(await n(principal)).toBeGreaterThan(0);
    expect(await n(teacher)).toBe(0);
  });
});

describe("the sharing column cannot be written directly", () => {
  it("refuses a direct update of the flag by the student", async () => {
    await expect(
      asUser(db, student, (tx) =>
        tx.query(`update render_profiles set share_with_teachers = true where user_id = $1`, [
          student,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a first save that tries to set the flag", async () => {
    await expect(
      asUser(db, loner, (tx) =>
        tx.query(
          `insert into render_profiles (user_id, profile, share_with_teachers) values ($1, '{}', true)`,
          [loner],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("still lets the student save their settings, new or changed", async () => {
    await asUser(db, loner, (tx) =>
      tx.query(
        `insert into render_profiles (user_id, profile) values ($1, '{"layout":"reader"}')`,
        [loner],
      ),
    );
    const changed = await asUser(db, student, (tx) =>
      tx.query(`update render_profiles set profile = '{"layout":"visual"}' where user_id = $1`, [
        student,
      ]),
    );
    expect(changed.affectedRows).toBe(1);
    const upsert = await asUser(db, student, (tx) =>
      tx.query(
        `insert into render_profiles (user_id, profile) values ($1, '{"layout":"reader"}')
         on conflict (user_id) do update set profile = excluded.profile`,
        [student],
      ),
    );
    expect(upsert.affectedRows).toBe(1);
  });

  it("keeps the flag when settings are saved", async () => {
    await share(student, true);
    await asUser(db, student, (tx) =>
      tx.query(
        `insert into render_profiles (user_id, profile) values ($1, '{"layout":"cards"}')
         on conflict (user_id) do update set profile = excluded.profile`,
        [student],
      ),
    );
    const flag = await db.query(
      `select share_with_teachers from render_profiles where user_id = $1`,
      [student],
    );
    expect(flag.rows).toEqual([{ share_with_teachers: true }]);
  });

  it("works for a learner who now can enable it after their first save", async () => {
    expect(await share(loner, true)).toBe(true);
  });
});

describe("last activity in the student progress view", () => {
  it("shows when each student last worked on an assigned lesson", async () => {
    const lesson = (
      await db.query<{ id: string }>(
        `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', 'published', 1) returning id`,
        [teacher],
      )
    ).rows[0].id;
    await db.query(`insert into assignments (classroom_id, lesson_id) values ($1, $2)`, [
      room,
      lesson,
    ]);
    await db.query(
      `insert into learning_events (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
       values ('01LAST000000000000000000A1', $1, $2, 1, 'lesson_started', 'cards', '2026-10-05T10:00:00Z'),
              ('01LAST000000000000000000A2', $1, $2, 1, 'session_paused', 'cards', '2026-10-06T11:30:00Z')`,
      [student, lesson],
    );
    const rows = await asUser(db, teacher, (tx) =>
      tx.query<{ last_active_at: Date | null }>(
        `select last_active_at from v_classroom_student_progress where student_id = $1`,
        [student],
      ),
    );
    expect(rows.rows[0].last_active_at?.toISOString()).toBe("2026-10-06T11:30:00.000Z");
  });
});
