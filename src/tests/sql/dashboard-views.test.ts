import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let principal: string;
let teacherA: string;
let teacherB: string;
let outsider: string;
let studentsA: string[]; // six students in A's class, using cards
let studentsB: string[]; // four students in B's class, using visual
let orgId: string;
let roomA: string;
let roomB: string;
let lesson: string;
let sequence = 0;

const one = async (sql: string, params: unknown[] = []) =>
  (await db.query<{ id: string }>(sql, params)).rows[0].id;

async function event(
  user: string,
  type: string,
  fields: { concept?: string; correct?: boolean; layout?: string; ms?: number; at?: string } = {},
) {
  sequence += 1;
  await db.query(
    `insert into learning_events
       (id, user_id, lesson_id, graph_version, type, concept_id, quiz_item_id, correct, duration_ms, layout, occurred_at)
     values ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10)`,
    [
      `01VIEWS${String(sequence).padStart(19, "0")}`,
      user,
      lesson,
      type,
      fields.concept ?? null,
      type === "quiz_answered" ? `q_${sequence}` : null,
      fields.correct ?? null,
      fields.ms ?? null,
      fields.layout ?? "cards",
      fields.at ?? new Date().toISOString(),
    ],
  );
}

const answer = (user: string, concept: string, correct: boolean, layout = "cards") =>
  event(user, "quiz_answered", { concept, correct, layout });

beforeAll(async () => {
  db = await createDb();
  principal = await createUser(db, "principal");
  teacherA = await createUser(db, "teacher_a");
  teacherB = await createUser(db, "teacher_b");
  outsider = await createUser(db, "outsider");
  studentsA = await Promise.all(["a1", "a2", "a3", "a4", "a5", "a6"].map((n) => createUser(db, n)));
  studentsB = await Promise.all(["b1", "b2", "b3", "b4"].map((n) => createUser(db, n)));

  orgId = await one(`insert into organizations (name, slug) values ('Oak', 'oak') returning id`);
  await db.query(
    `insert into org_memberships (org_id, user_id, role) values ($1, $2, 'principal'), ($1, $3, 'teacher'), ($1, $4, 'teacher')`,
    [orgId, principal, teacherA, teacherB],
  );
  roomA = await one(
    `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, 'A', 'AAAAAA') returning id`,
    [orgId, teacherA],
  );
  roomB = await one(
    `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, 'B', 'BBBBBB') returning id`,
    [orgId, teacherB],
  );
  for (const s of studentsA) await db.query(`insert into enrollments values ($1, $2)`, [roomA, s]);
  for (const s of studentsB) await db.query(`insert into enrollments values ($1, $2)`, [roomB, s]);

  lesson = await one(
    `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', 'published', 1) returning id`,
    [teacherA],
  );
  await db.query(
    `insert into concepts (id, lesson_id, graph_version, order_index, title, summary, retired)
     values ('c_1', $1, 1, 0, 'One', 'S', false), ('c_2', $1, 1, 1, 'Two', 'S', false),
            ('c_old', $1, 1, 2, 'Old', 'S', true)`,
    [lesson],
  );
  await db.query(`insert into assignments (classroom_id, lesson_id) values ($1, $2), ($3, $2)`, [
    roomA,
    lesson,
    roomB,
  ]);

  // a1 masters both ideas; a2 gets one wrong then masters c_1; everyone else has one event.
  await answer(studentsA[0], "c_1", true);
  await answer(studentsA[0], "c_1", true);
  await answer(studentsA[0], "c_2", true);
  await answer(studentsA[0], "c_2", true);
  await event(studentsA[0], "concept_viewed", { concept: "c_1", ms: 30_000 });
  await event(studentsA[0], "concept_viewed", { concept: "c_2", ms: 600_000 }); // idle, capped at 60 s
  await answer(studentsA[1], "c_1", false);
  await answer(studentsA[1], "c_1", true);
  await answer(studentsA[1], "c_1", true);
  for (const s of studentsA.slice(2)) await event(s, "concept_viewed", { concept: "c_1" });
  for (const s of studentsB) await answer(s, "c_1", true, "visual");
});

afterAll(async () => {
  await db.close();
});

type Row = Record<string, unknown>;
const read = (user: string, sql: string) =>
  asUser(db, user, (tx) => tx.query<Row>(sql)).then((r) => r.rows);

describe("v_classroom_student_progress", () => {
  it("gives a teacher their own students, each with progress on one scale", async () => {
    const rows = await read(
      teacherA,
      `select display_name, total_concepts, mastered_concepts, answered, correct, active_seconds
       from v_classroom_student_progress order by display_name`,
    );
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({
      display_name: "a1",
      total_concepts: 2, // the retired idea is not counted
      mastered_concepts: 2,
      answered: 4,
      correct: 4,
      active_seconds: 90, // 30 s plus 600 s capped at 60 s
    });
    expect(rows[1]).toMatchObject({
      display_name: "a2",
      mastered_concepts: 1,
      answered: 3,
      correct: 2,
    });
    expect(rows[2]).toMatchObject({ display_name: "a3", mastered_concepts: 0, answered: 0 });
  });

  it("shows a teacher nothing from another teacher's classroom", async () => {
    const rows = await read(
      teacherA,
      `select distinct classroom_id from v_classroom_student_progress`,
    );
    expect(rows).toEqual([{ classroom_id: roomA }]);
  });

  it("shows the principal every classroom, and a stranger nothing", async () => {
    const rows = await read(
      principal,
      `select distinct classroom_id from v_classroom_student_progress`,
    );
    expect(rows.map((r) => r.classroom_id).sort()).toEqual([roomA, roomB].sort());
    expect(await read(outsider, `select 1 from v_classroom_student_progress`)).toEqual([]);
    expect(await read(studentsA[0], `select 1 from v_classroom_student_progress`)).toEqual([]);
  });

  it("does not expose a learner's layout", async () => {
    const rows = await read(teacherA, `select * from v_classroom_student_progress limit 1`);
    expect(Object.keys(rows[0]).join(",")).not.toMatch(/layout|profile/);
  });
});

describe("v_classroom_concept_difficulty", () => {
  it("reports attempts and error rate per idea for the teacher's classroom", async () => {
    const rows = await read(
      teacherA,
      `select concept_id, attempts, correct, error_rate::float as error_rate
       from v_classroom_concept_difficulty order by concept_id`,
    );
    // c_1: a1 2 right, a2 1 wrong + 2 right -> 5 attempts, 4 right. c_2: a1 2 right.
    expect(rows).toEqual([
      { concept_id: "c_1", attempts: 5, correct: 4, error_rate: 0.2 },
      { concept_id: "c_2", attempts: 2, correct: 2, error_rate: 0 },
    ]);
  });

  it("leaves an idea nobody has answered with no error rate, and skips retired ideas", async () => {
    const rows = await read(
      teacherB,
      `select concept_id, attempts, error_rate from v_classroom_concept_difficulty order by concept_id`,
    );
    expect(rows).toEqual([
      { concept_id: "c_1", attempts: 4, error_rate: "0.000" },
      { concept_id: "c_2", attempts: 0, error_rate: null },
    ]);
  });

  it("is closed to people who do not run the classroom", async () => {
    expect(await read(outsider, `select 1 from v_classroom_concept_difficulty`)).toEqual([]);
  });
});

describe("v_org_classroom_summary", () => {
  it("gives the principal one row per classroom with completion and average mastery", async () => {
    const rows = await read(
      principal,
      `select classroom_name, students, assigned_lessons, active_learners,
              completion::float as completion, average_mastery::float as average_mastery
       from v_org_classroom_summary order by classroom_name`,
    );
    expect(rows).toEqual([
      // six students: a1 finished (1), a2 half (0.5), four with none; one lesson each
      {
        classroom_name: "A",
        students: 6,
        assigned_lessons: 1,
        active_learners: 6,
        completion: 0.167,
        average_mastery: 0.25,
      },
      // four students, each mastered c_1 of two? one correct answer is not mastery
      {
        classroom_name: "B",
        students: 4,
        assigned_lessons: 1,
        active_learners: 4,
        completion: 0,
        average_mastery: 0,
      },
    ]);
  });

  it("is for principals only", async () => {
    expect(await read(teacherA, `select 1 from v_org_classroom_summary`)).toEqual([]);
    expect(await read(outsider, `select 1 from v_org_classroom_summary`)).toEqual([]);
  });

  it("counts only recent activity as active", async () => {
    await db.query(
      `update learning_events set occurred_at = now() - interval '30 days' where user_id = $1`,
      [studentsB[0]],
    );
    const rows = await read(
      principal,
      `select active_learners from v_org_classroom_summary where classroom_name = 'B'`,
    );
    expect(rows).toEqual([{ active_learners: 3 }]);
  });
});

describe("v_org_layout_usage", () => {
  it("shows a layout used by five or more learners and hides a group of four", async () => {
    const rows = await read(
      principal,
      `select layout, learners, share::float as share from v_org_layout_usage`,
    );
    // cards: six learners. visual: four, which is hidden.
    expect(rows).toEqual([{ layout: "cards", learners: 6, share: 1 }]);
  });

  it("shows the group once it reaches five", async () => {
    const extra = await createUser(db, "b5");
    await db.query(`insert into enrollments values ($1, $2)`, [roomB, extra]);
    await answer(extra, "c_1", true, "visual");
    const rows = await read(
      principal,
      `select layout, learners, share::float as share from v_org_layout_usage order by layout`,
    );
    expect(rows).toEqual([
      { layout: "cards", learners: 6, share: 0.545 },
      { layout: "visual", learners: 5, share: 0.455 },
    ]);
  });

  it("is for principals only", async () => {
    expect(await read(teacherA, `select 1 from v_org_layout_usage`)).toEqual([]);
  });
});

describe("v_classroom_concept_mastery", () => {
  it("has a cell for every student and every current idea, with not_started where nothing has happened", async () => {
    const rows = await read(
      teacherA,
      `select display_name, concept_id, status, attempts from v_classroom_concept_mastery
       where display_name in ('a1', 'a2', 'a3') order by display_name, order_index`,
    );
    expect(rows).toEqual([
      { display_name: "a1", concept_id: "c_1", status: "mastered", attempts: 2 },
      { display_name: "a1", concept_id: "c_2", status: "mastered", attempts: 2 },
      { display_name: "a2", concept_id: "c_1", status: "mastered", attempts: 3 },
      { display_name: "a2", concept_id: "c_2", status: "not_started", attempts: 0 },
      { display_name: "a3", concept_id: "c_1", status: "in_progress", attempts: 0 }, // viewed, not yet asked
      { display_name: "a3", concept_id: "c_2", status: "not_started", attempts: 0 },
    ]);
  });

  it("leaves out retired ideas and the classroom's other teachers' students", async () => {
    const rows = await read(
      teacherA,
      `select distinct concept_id, classroom_id from v_classroom_concept_mastery`,
    );
    expect(rows.map((r) => r.concept_id).sort()).toEqual(["c_1", "c_2"]);
    expect(new Set(rows.map((r) => r.classroom_id))).toEqual(new Set([roomA]));
  });

  it("is closed to people who do not run the classroom, and carries no layout", async () => {
    expect(await read(outsider, `select 1 from v_classroom_concept_mastery`)).toEqual([]);
    expect(await read(studentsA[0], `select 1 from v_classroom_concept_mastery`)).toEqual([]);
    const columns = await read(principal, `select * from v_classroom_concept_mastery limit 1`);
    expect(Object.keys(columns[0]).join(",")).not.toMatch(/layout|profile/);
  });
});
