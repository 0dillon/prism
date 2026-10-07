import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let principal: string;
let teacher: string;
let outsider: string;
let students: string[];
let orgId: string;
let roomA: string;
let roomB: string;
let archivedRoom: string;
let lesson: string;
let sequence = 0;

async function event(
  user: string,
  at: string,
  fields: { type?: string; concept?: string; correct?: boolean; ms?: number; layout?: string } = {},
) {
  sequence += 1;
  const type = fields.type ?? "concept_viewed";
  await db.query(
    `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, quiz_item_id, correct, duration_ms, layout, occurred_at)
     values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)`,
    [
      `01ACTIVITY${String(sequence).padStart(16, "0")}`,
      user,
      lesson,
      type,
      fields.concept ?? "c_1",
      type === "quiz_answered" ? `q_${sequence}` : null,
      fields.correct ?? null,
      fields.ms ?? 1000,
      fields.layout ?? "cards",
      at,
    ],
  );
}

beforeAll(async () => {
  db = await createDb();
  principal = await createUser(db, "principal");
  teacher = await createUser(db, "teacher");
  outsider = await createUser(db, "outsider");
  students = await Promise.all(["s1", "s2", "s3", "s4"].map((n) => createUser(db, n)));

  const one = async (sql: string, params: unknown[] = []) =>
    (await db.query<{ id: string }>(sql, params)).rows[0].id;
  orgId = await one(`insert into organizations (name, slug) values ('Oak', 'oak') returning id`);
  await db.query(
    `insert into org_memberships (org_id, user_id, role) values ($1, $2, 'principal'), ($1, $3, 'teacher')`,
    [orgId, principal, teacher],
  );
  const room = (name: string, code: string) =>
    one(
      `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, $3, $4) returning id`,
      [orgId, teacher, name, code],
    );
  roomA = await room("A", "AAAAAA");
  roomB = await room("B", "BBBBBB");
  archivedRoom = await room("Old", "CCCCCC");
  await db.query(`update classrooms set archived_at = now() where id = $1`, [archivedRoom]);
  await db.query(`insert into enrollments values ($1, $2), ($1, $3), ($4, $5), ($6, $2)`, [
    roomA,
    students[0],
    students[1],
    roomB,
    students[2],
    archivedRoom,
  ]);
  lesson = await one(
    `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', 'published', 1) returning id`,
    [teacher],
  );
  await db.query(
    `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
     values ('c_1', $1, 1, 0, 'One', 'S'), ('c_2', $1, 1, 1, 'Two', 'S')`,
    [lesson],
  );
  await db.query(
    `insert into assignments (classroom_id, lesson_id) values ($1, $4), ($2, $4), ($3, $4)`,
    [roomA, roomB, archivedRoom, lesson],
  );

  // Week of 5 Oct 2026 (a Monday): s1 and s2 are active; s1 masters c_1 (two right in a row).
  await event(students[0], "2026-10-06T10:00:00Z", { ms: 30_000 });
  await event(students[0], "2026-10-06T10:05:00Z", {
    type: "quiz_answered",
    correct: true,
    ms: 600_000,
  }); // capped at 60 s
  await event(students[0], "2026-10-06T10:06:00Z", {
    type: "quiz_answered",
    correct: true,
    ms: 10_000,
  });
  await event(students[1], "2026-10-07T09:00:00Z", { ms: 20_000 });
  // Week of 12 Oct: s3 (class B) active.
  await event(students[2], "2026-10-13T09:00:00Z", { ms: 40_000 });
  // A student in the archived class only, and a student in no class: neither is counted.
  await event(students[3], "2026-10-06T12:00:00Z", { ms: 99_000 });
});

afterAll(async () => {
  await db.close();
});

const activity = (user: string, from: string, to: string) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<{ classroom_id: string; active_learners: number; active_seconds: number }>(
          `select * from org_classroom_activity($1, $2, $3)`,
          [orgId, from, to],
        )
      ).rows,
  );

const weekly = (user: string, from: string, to: string) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<{
          week_start: Date;
          active_learners: number;
          active_seconds: number;
          mastered_ideas: number;
        }>(`select * from org_weekly_activity($1, $2, $3)`, [orgId, from, to])
      ).rows,
  );

describe("org_classroom_activity", () => {
  it("counts learners who did something in the range and their time, per classroom", async () => {
    const rows = await activity(principal, "2026-10-01", "2026-10-31");
    const byRoom = Object.fromEntries(rows.map((r) => [r.classroom_id, r]));
    expect(byRoom[roomA]).toMatchObject({ active_learners: 2, active_seconds: 120 }); // 30 + 60 + 10 + 20
    expect(byRoom[roomB]).toMatchObject({ active_learners: 1, active_seconds: 40 });
  });

  it("leaves a classroom with no activity at zero, and archived classrooms out", async () => {
    const rows = await activity(principal, "2026-09-01", "2026-09-30");
    expect(rows.map((r) => [r.active_learners, r.active_seconds])).toEqual([
      [0, 0],
      [0, 0],
    ]);
    const all = await activity(principal, "2026-10-01", "2026-10-31");
    expect(all.map((r) => r.classroom_id)).not.toContain(archivedRoom);
  });

  it("includes the first and last day of the range, and nothing outside it", async () => {
    const week2 = await activity(principal, "2026-10-13", "2026-10-13");
    expect(Object.fromEntries(week2.map((r) => [r.classroom_id, r.active_learners]))[roomB]).toBe(
      1,
    );
    const before = await activity(principal, "2026-10-07", "2026-10-12");
    expect(Object.fromEntries(before.map((r) => [r.classroom_id, r.active_learners]))[roomB]).toBe(
      0,
    );
  });

  it("is for the organization's principal only", async () => {
    await expect(activity(teacher, "2026-10-01", "2026-10-31")).rejects.toThrow(
      /only the principal/,
    );
    await expect(activity(outsider, "2026-10-01", "2026-10-31")).rejects.toThrow(
      /only the principal/,
    );
  });

  it("refuses a backwards range or one longer than a year", async () => {
    await expect(activity(principal, "2026-10-31", "2026-10-01")).rejects.toThrow(/date range/);
    await expect(activity(principal, "2024-01-01", "2026-10-01")).rejects.toThrow(/date range/);
  });
});

describe("org_weekly_activity", () => {
  it("has a row for every week in the range, with zeros where nothing happened", async () => {
    const rows = await weekly(principal, "2026-09-28", "2026-10-18");
    expect(rows.map((r) => r.week_start.toISOString().slice(0, 10))).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(rows.map((r) => r.active_learners)).toEqual([0, 2, 1]);
  });

  it("adds up time with idle time capped, and counts ideas mastered", async () => {
    const rows = await weekly(principal, "2026-09-28", "2026-10-18");
    expect(rows.map((r) => r.active_seconds)).toEqual([0, 120, 40]);
    expect(rows.map((r) => r.mastered_ideas)).toEqual([0, 1, 0]);
  });

  it("does not count a student who is only in an archived class, or in none", async () => {
    const rows = await weekly(principal, "2026-10-05", "2026-10-11");
    expect(rows[0].active_learners).toBe(2);
  });

  it("is for the principal only, and refuses a range over a year", async () => {
    await expect(weekly(teacher, "2026-10-01", "2026-10-31")).rejects.toThrow(/only the principal/);
    await expect(weekly(principal, "2020-01-01", "2026-10-01")).rejects.toThrow(/date range/);
  });
});

describe("a school of 1,000 students", () => {
  const STUDENTS = 1000;
  const CLASSES = 40;
  let bigOrg: string;
  let bigPrincipal: string;
  let queryMs: Record<string, number>;

  beforeAll(async () => {
    bigPrincipal = await createUser(db, "big_principal");
    const bigTeacher = await createUser(db, "big_teacher");
    bigOrg = (
      await db.query<{ id: string }>(
        `insert into organizations (name, slug) values ('Big', 'big') returning id`,
      )
    ).rows[0].id;
    await db.query(
      `insert into org_memberships values ($1, $2, 'principal', now()), ($1, $3, 'teacher', now())`,
      [bigOrg, bigPrincipal, bigTeacher],
    );
    await db.query(
      `insert into classrooms (org_id, teacher_id, name, join_code)
       select $1, $2, 'Class ' || g, public.new_join_code() from generate_series(1, ${CLASSES}) g`,
      [bigOrg, bigTeacher],
    );
    // Students are made in bulk. The signup trigger makes their public rows.
    await db.query(
      `insert into auth.users (email, raw_user_meta_data, email_confirmed_at)
       select 'big' || g || '@example.test', jsonb_build_object('display_name', 'Big ' || g), now()
       from generate_series(1, ${STUDENTS}) g`,
    );
    await db.query(
      `insert into enrollments (classroom_id, student_id)
       select (select id from classrooms where org_id = $1 order by name limit 1 offset (s.n % ${CLASSES})), s.id
       from (select u.id, row_number() over (order by u.email) as n
             from auth.users u where u.email like 'big%@example.test' and u.email <> 'big_principal@example.test'
               and u.email <> 'big_teacher@example.test') s`,
      [bigOrg],
    );
    const bigLesson = (
      await db.query<{ id: string }>(
        `insert into lessons (owner_id, title, status, graph_version) values ($1, 'Big', 'published', 1) returning id`,
        [bigTeacher],
      )
    ).rows[0].id;
    await db.query(
      `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
       select 'c_' || g, $1, 1, g, 'Idea ' || g, 'S' from generate_series(1, 6) g`,
      [bigLesson],
    );
    await db.query(
      `insert into assignments (classroom_id, lesson_id) select id, $1 from classrooms where org_id = $2`,
      [bigLesson, bigOrg],
    );
    // Each student answers six questions across six ideas over the last month.
    await db.query(
      `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, quiz_item_id, correct, duration_ms, layout, occurred_at)
       select 'BIG' || lpad((row_number() over ())::text, 20, '0'), e.student_id, $1, 1, 'quiz_answered',
              'c_' || k, 'q_' || k, (e.student_id::text > '8'), 8000, 'cards',
              now() - ((k * 4 + (abs(hashtext(e.student_id::text)) % 20)) || ' days')::interval
       from enrollments e join classrooms c on c.id = e.classroom_id and c.org_id = $2
       cross join generate_series(1, 6) k`,
      [bigLesson, bigOrg],
    );

    const time = async (name: string, sql: string) => {
      const start = performance.now();
      await asUser(db, bigPrincipal, (tx) => tx.query(sql, [bigOrg]));
      queryMs[name] = performance.now() - start;
    };
    queryMs = {};
    await time("summary", `select * from v_org_classroom_summary where org_id = $1`);
    await time(
      "activity",
      `select * from org_classroom_activity($1, (now() - interval '30 days')::date, now()::date)`,
    );
    await time(
      "weekly",
      `select * from org_weekly_activity($1, (now() - interval '90 days')::date, now()::date)`,
    );
  }, 240_000);

  it("seeded a school of 1,000 students in 40 classes", async () => {
    const counts = await db.query<{ students: number; classes: number }>(
      `select count(*)::int as students, count(distinct e.classroom_id)::int as classes
       from enrollments e join classrooms c on c.id = e.classroom_id where c.org_id = $1`,
      [bigOrg],
    );
    expect(counts.rows[0].students).toBeGreaterThanOrEqual(STUDENTS - 2);
    expect(counts.rows[0].classes).toBe(CLASSES);
  });

  it("loads the classroom summary in under 2 seconds", () => {
    expect(queryMs.summary).toBeLessThan(2000);
  });

  it("loads activity for a date range in under 2 seconds", () => {
    expect(queryMs.activity).toBeLessThan(2000);
  });

  it("loads the weekly series in under 2 seconds", () => {
    expect(queryMs.weekly).toBeLessThan(2000);
  });

  it("returns a row for each classroom", async () => {
    const rows = await asUser(db, bigPrincipal, (tx) =>
      tx.query(`select * from v_org_classroom_summary where org_id = $1`, [bigOrg]),
    );
    expect(rows.rows).toHaveLength(CLASSES);
  });
});
