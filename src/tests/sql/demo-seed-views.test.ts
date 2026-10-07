import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SAMPLE_LESSON } from "@/lib/demo/sample-lesson";
import { DEMO_LEARNER_ACCOUNTS, progressEvents } from "@/lib/demo/seed-plan";
import { asUser, assignLesson, createDb, createUser, type Db } from "./harness";

/**
 * The demo seed, run through the real publish function and the dashboard views, so what the
 * teacher's grid and the principal's summary show is what the seed intends: Maya has mastered
 * 5 of the lesson's ideas, Tunde 3 and Sofia 1.
 */

let db: Db;
let teacher: string;
let lessonId: string;
let roomId: string;
const learners = new Map<string, string>();

beforeAll(async () => {
  db = await createDb();
  teacher = await createUser(db, "demo_teacher");
  lessonId = (
    await db.query<{ id: string }>(
      `insert into lessons (owner_id, title, status, graph_version, graph)
       values ($1, $2, 'needs_review', 0, $3) returning id`,
      [teacher, SAMPLE_LESSON.title, JSON.stringify(SAMPLE_LESSON)],
    )
  ).rows[0].id;
  const version = await asUser(
    db,
    teacher,
    async (tx) =>
      (
        await tx.query<{ v: number }>(`select publish_lesson($1, $2) as v`, [
          lessonId,
          JSON.stringify({ ...SAMPLE_LESSON, lessonId }),
        ])
      ).rows[0].v,
  );

  for (const learner of DEMO_LEARNER_ACCOUNTS) {
    const id = await createUser(db, `demo_${learner.key}`);
    await db.query(`update users_public set display_name = $2 where id = $1`, [
      id,
      learner.displayName,
    ]);
    learners.set(learner.displayName, id);
    for (const event of progressEvents({ userId: id, lessonId, graphVersion: version, learner })) {
      await db.query(
        `insert into learning_events
           (id, user_id, lesson_id, graph_version, type, concept_id, quiz_item_id, correct, duration_ms, layout, occurred_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          event.id,
          event.user_id,
          event.lesson_id,
          event.graph_version,
          event.type,
          event.concept_id,
          event.quiz_item_id,
          event.correct,
          event.duration_ms,
          event.layout,
          event.occurred_at,
        ],
      );
    }
  }
  await assignLesson(db, teacher, lessonId, [...learners.values()]);
  roomId = (await db.query<{ id: string }>(`select id from classrooms limit 1`)).rows[0].id;
});

afterAll(async () => {
  await db.close();
});

describe("the demo seed, as the dashboards read it", () => {
  it("shows each learner's mastered ideas on one scale in the student progress view", async () => {
    const rows = await asUser(db, teacher, (tx) =>
      tx.query<{ display_name: string; mastered_concepts: number; total_concepts: number }>(
        `select display_name, mastered_concepts, total_concepts from v_classroom_student_progress
         where classroom_id = $1 order by display_name`,
        [roomId],
      ),
    );
    const total = SAMPLE_LESSON.concepts.length;
    expect(rows.rows).toEqual([
      { display_name: "Maya", mastered_concepts: 5, total_concepts: total },
      { display_name: "Sofia", mastered_concepts: 1, total_concepts: total },
      { display_name: "Tunde", mastered_concepts: 3, total_concepts: total },
    ]);
  });

  it("agrees cell by cell in the concept grid view", async () => {
    const rows = await asUser(db, teacher, (tx) =>
      tx.query<{ display_name: string; mastered: number; cells: number }>(
        `select display_name,
                count(*) filter (where status = 'mastered')::int as mastered,
                count(*)::int as cells
         from v_classroom_concept_mastery where classroom_id = $1
         group by display_name order by display_name`,
        [roomId],
      ),
    );
    const total = SAMPLE_LESSON.concepts.length;
    expect(rows.rows).toEqual([
      { display_name: "Maya", mastered: 5, cells: total },
      { display_name: "Sofia", mastered: 1, cells: total },
      { display_name: "Tunde", mastered: 3, cells: total },
    ]);
  });

  it("masters the first ideas in order, which is what the seed intends", async () => {
    const rows = await asUser(db, teacher, (tx) =>
      tx.query<{ concept_id: string; status: string }>(
        `select concept_id, status from v_classroom_concept_mastery
         where classroom_id = $1 and display_name = 'Tunde' order by order_index`,
        [roomId],
      ),
    );
    const order = [...SAMPLE_LESSON.concepts].sort((a, b) => a.order - b.order);
    expect(rows.rows.map((r) => r.status === "mastered")).toEqual(
      order.map((_, index) => index < 3),
    );
  });
});
