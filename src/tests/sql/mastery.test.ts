import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, assignLesson, createDb, createUser, type Db } from "./harness";

let db: Db;
let owner: string;
let lesson: string;
let sequence = 0;

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner");
  lesson = (
    await db.query<{ id: string }>(
      `insert into lessons (owner_id, status, graph_version) values ($1, 'published', 1) returning id`,
      [owner],
    )
  ).rows[0].id;
  await db.query(
    `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
     values ('c_1', $1, 1, 0, 'T', 'S'), ('c_2', $1, 1, 1, 'T2', 'S2')`,
    [lesson],
  );
});

afterAll(async () => {
  await db.close();
});

/** A fresh learner so each test sees only its own mastery rows. */
const learner = async (name: string) => {
  const id = await createUser(db, name);
  await assignLesson(db, owner, lesson, [id]);
  return id;
};

let clock = Date.parse("2026-10-06T10:00:00Z");

async function answer(
  user: string,
  concept: string,
  correct: boolean,
  options: { at?: number; layout?: string } = {},
) {
  sequence += 1;
  clock += 1000;
  await db.query(
    `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, quiz_item_id, correct, layout, occurred_at)
     values ($1, $2, $3, 1, 'quiz_answered', $4, $5, $6, $7, $8)`,
    [
      `01MASTERY${String(sequence).padStart(17, "0")}`,
      user,
      lesson,
      concept,
      `q_${sequence}`,
      correct,
      options.layout ?? "cards",
      new Date(options.at ?? clock).toISOString(),
    ],
  );
}

async function view(user: string, concept: string) {
  sequence += 1;
  clock += 1000;
  await db.query(
    `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, layout, occurred_at)
     values ($1, $2, $3, 1, 'concept_viewed', $4, 'cards', $5)`,
    [
      `01MASTERY${String(sequence).padStart(17, "0")}`,
      user,
      lesson,
      concept,
      new Date(clock).toISOString(),
    ],
  );
}

async function mastery(user: string, concept: string) {
  const { rows } = await db.query<{
    status: string;
    attempts: number;
    correct_count: number;
    last_two_correct: boolean;
  }>(
    `select status, attempts, correct_count, last_two_correct from concept_mastery
     where user_id = $1 and lesson_id = $2 and concept_id = $3`,
    [user, lesson, concept],
  );
  return rows[0];
}

describe("concept_mastery trigger", () => {
  it("has no row before the learner has seen the concept", async () => {
    const user = await learner("fresh");
    expect(await mastery(user, "c_1")).toBeUndefined();
  });

  it("marks a viewed concept in progress", async () => {
    const user = await learner("viewer");
    await view(user, "c_1");
    expect(await mastery(user, "c_1")).toEqual({
      status: "in_progress",
      attempts: 0,
      correct_count: 0,
      last_two_correct: false,
    });
  });

  it("sets mastered after two consecutive correct answers", async () => {
    const user = await learner("two_correct");
    await answer(user, "c_1", true);
    expect(await mastery(user, "c_1")).toMatchObject({ status: "in_progress", attempts: 1 });
    await answer(user, "c_1", true);
    expect(await mastery(user, "c_1")).toEqual({
      status: "mastered",
      attempts: 2,
      correct_count: 2,
      last_two_correct: true,
    });
  });

  it("returns to in progress after a later wrong answer", async () => {
    const user = await learner("regress");
    await answer(user, "c_1", true);
    await answer(user, "c_1", true);
    await answer(user, "c_1", false);
    expect(await mastery(user, "c_1")).toEqual({
      status: "in_progress",
      attempts: 3,
      correct_count: 2,
      last_two_correct: false,
    });
  });

  it("needs two fresh correct answers after a wrong one", async () => {
    const user = await learner("recover");
    await answer(user, "c_1", false);
    await answer(user, "c_1", true);
    expect((await mastery(user, "c_1")).status).toBe("in_progress");
    await answer(user, "c_1", true);
    expect((await mastery(user, "c_1")).status).toBe("mastered");
  });

  it("does not master from non-consecutive correct answers", async () => {
    const user = await learner("alternating");
    await answer(user, "c_1", true);
    await answer(user, "c_1", false);
    await answer(user, "c_1", true);
    expect(await mastery(user, "c_1")).toMatchObject({
      status: "in_progress",
      attempts: 3,
      correct_count: 2,
    });
  });

  it("tracks each concept independently", async () => {
    const user = await learner("independent");
    await answer(user, "c_1", true);
    await answer(user, "c_1", true);
    await answer(user, "c_2", false);
    expect((await mastery(user, "c_1")).status).toBe("mastered");
    expect((await mastery(user, "c_2")).status).toBe("in_progress");
  });

  it("keeps mastery when the concept is viewed again", async () => {
    const user = await learner("revisit");
    await answer(user, "c_1", true);
    await answer(user, "c_1", true);
    await view(user, "c_1");
    expect((await mastery(user, "c_1")).status).toBe("mastered");
  });

  it("orders answers by when they happened, not when they arrived", async () => {
    const user = await learner("late_arrival");
    const base = Date.parse("2026-10-06T12:00:00Z");
    // The wrong answer happened first but its event arrives last.
    await answer(user, "c_1", true, { at: base + 2000 });
    await answer(user, "c_1", true, { at: base + 3000 });
    await answer(user, "c_1", false, { at: base + 1000 });
    expect((await mastery(user, "c_1")).status).toBe("mastered");
  });

  it("gives the same result whatever layout produced the answers", async () => {
    const results: string[] = [];
    for (const layout of ["reader", "cards", "conversation", "visual"]) {
      const user = await learner(`layout_${layout}`);
      await answer(user, "c_1", true, { layout });
      await answer(user, "c_1", true, { layout });
      await answer(user, "c_2", false, { layout });
      const a = await mastery(user, "c_1");
      const b = await mastery(user, "c_2");
      results.push(JSON.stringify([a, b]));
    }
    expect(new Set(results).size).toBe(1);
  });

  it("ignores events for a concept the lesson does not have", async () => {
    const user = await learner("ghost");
    await answer(user, "c_ghost", true);
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from concept_mastery where user_id = $1`,
      [user],
    );
    expect(rows[0].n).toBe(0);
    const events = await db.query<{ n: number }>(
      `select count(*)::int as n from learning_events where user_id = $1`,
      [user],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it("ignores other event types", async () => {
    const user = await learner("started");
    await db.query(
      `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, layout, occurred_at)
       values ('01MASTERY0000000000000SKIP', $1, $2, 1, 'quiz_presented', 'c_1', 'cards', now())`,
      [user, lesson],
    );
    expect(await mastery(user, "c_1")).toBeUndefined();
  });

  it("does not double count a replayed event", async () => {
    const user = await learner("replay");
    const insert = `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, correct, layout, occurred_at)
                    values ('01MASTERY0000000000REPLAY1', $1, $2, 1, 'quiz_answered', 'c_1', true, 'cards', now())
                    on conflict (id) do nothing`;
    await db.query(insert, [user, lesson]);
    await db.query(insert, [user, lesson]);
    expect((await mastery(user, "c_1")).attempts).toBe(1);
  });

  it("fires for events a learner inserts through row-level security", async () => {
    const user = await learner("through_rls");
    await asUser(db, user, (tx) =>
      tx.query(
        `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, correct, layout, occurred_at)
         values ('01MASTERY00000000000RLS01', $1, $2, 1, 'quiz_answered', 'c_1', true, 'visual', now()),
                ('01MASTERY00000000000RLS02', $1, $2, 1, 'quiz_answered', 'c_1', true, 'visual', now() + interval '1 second')`,
        [user, lesson],
      ),
    );
    const rows = await asUser(
      db,
      user,
      async (tx) => (await tx.query<{ status: string }>(`select status from concept_mastery`)).rows,
    );
    expect(rows).toEqual([{ status: "mastered" }]);
  });
});
