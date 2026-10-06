import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeGraph } from "../fixtures/graph";
import { asService, asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let teacher: string;
let learner: string;
let other: string;

beforeAll(async () => {
  db = await createDb();
  teacher = await createUser(db, "teacher");
  learner = await createUser(db, "learner");
  other = await createUser(db, "other");
});

afterAll(async () => {
  await db.close();
});

async function draftLesson(
  graph = makeGraph(),
  status = "needs_review",
  version = 0,
  owner = teacher,
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into lessons (owner_id, title, status, graph, graph_version) values ($1, $2, $3, $4, $5) returning id`,
    [owner, graph.title, status, JSON.stringify(graph), version],
  );
  return rows[0].id;
}

const publish = (user: string, lessonId: string, graph: unknown) =>
  asUser(db, user, async (tx) => {
    const { rows } = await tx.query<{ publish_lesson: number }>(
      `select publish_lesson($1, $2) as publish_lesson`,
      [lessonId, JSON.stringify(graph)],
    );
    return rows[0].publish_lesson;
  });

const concepts = async (lessonId: string) =>
  (
    await db.query<{
      id: string;
      retired: boolean;
      graph_version: number;
      order_index: number;
      title: string;
      key_term: string | null;
    }>(
      `select id, retired, graph_version, order_index, title, key_term from concepts where lesson_id = $1 order by order_index`,
      [lessonId],
    )
  ).rows;

const quizItems = async (lessonId: string) =>
  (
    await db.query<{ id: string; retired: boolean; type: string; concept_id: string }>(
      `select id, retired, type, concept_id from quiz_items where lesson_id = $1 order by id`,
      [lessonId],
    )
  ).rows;

const lessonRow = async (lessonId: string) =>
  (
    await db.query<{ status: string; graph_version: number; title: string }>(
      `select status, graph_version, title from lessons where id = $1`,
      [lessonId],
    )
  ).rows[0];

describe("publish_lesson", () => {
  it("publishes a draft: version 1, status published, normalized rows written", async () => {
    const id = await draftLesson();
    const version = await publish(teacher, id, makeGraph());
    expect(version).toBe(1);
    expect(await lessonRow(id)).toMatchObject({ status: "published", graph_version: 1 });

    const rows = await concepts(id);
    expect(rows.map((c) => [c.id, c.order_index, c.graph_version, c.retired])).toEqual([
      ["c_evaporation", 0, 1, false],
      ["c_condensation", 1, 1, false],
      ["c_precipitation", 2, 1, false],
    ]);
    expect(rows[0].key_term).toBe("evaporation");
    const items = await quizItems(id);
    expect(items).toHaveLength(6);
    expect(items.every((q) => !q.retired)).toBe(true);
    expect(items.find((q) => q.id === "q_condensation_2")).toMatchObject({
      type: "short_answer",
      concept_id: "c_condensation",
    });
  });

  it("stores the published graph and takes the title from it", async () => {
    const graph = makeGraph();
    graph.title = "A Better Title";
    const id = await draftLesson();
    await publish(teacher, id, graph);
    const { rows } = await db.query<{ graph: { title: string } }>(
      `select graph from lessons where id = $1`,
      [id],
    );
    expect(rows[0].graph.title).toBe("A Better Title");
    expect((await lessonRow(id)).title).toBe("A Better Title");
  });

  it("lets an entitled learner read the lesson, its concepts and quiz items afterwards", async () => {
    const id = await draftLesson();
    await publish(teacher, id, makeGraph());
    const seen = await asUser(db, learner, async (tx) => ({
      lessons: (await tx.query(`select id from lessons where id = $1`, [id])).rows.length,
      concepts: (await tx.query(`select id from concepts where lesson_id = $1`, [id])).rows.length,
      items: (await tx.query(`select id from quiz_items where lesson_id = $1`, [id])).rows.length,
    }));
    expect(seen).toEqual({ lessons: 1, concepts: 3, items: 6 });
  });

  it("keeps a draft invisible to learners until it is published", async () => {
    const id = await draftLesson();
    const before = await asUser(
      db,
      learner,
      async (tx) => (await tx.query(`select id from lessons where id = $1`, [id])).rows.length,
    );
    expect(before).toBe(0);
  });

  it("refuses a user who does not own the lesson, and changes nothing", async () => {
    const id = await draftLesson();
    await expect(publish(other, id, makeGraph())).rejects.toThrow(/lesson not found/);
    await expect(publish(learner, id, makeGraph())).rejects.toThrow(/lesson not found/);
    expect((await lessonRow(id)).status).toBe("needs_review");
    expect(await concepts(id)).toEqual([]);
  });

  it("refuses a lesson that is not in needs_review", async () => {
    for (const status of ["uploading", "processing", "failed", "published"]) {
      const id = await draftLesson(makeGraph(), status);
      await expect(publish(teacher, id, makeGraph()), status).rejects.toThrow(
        /not ready to publish/,
      );
    }
  });

  it("refuses a graph with no concepts", async () => {
    const id = await draftLesson();
    await expect(
      publish(teacher, id, { ...makeGraph(), concepts: [], quizItems: [] }),
    ).rejects.toThrow(/no concepts/);
    await expect(publish(teacher, id, { title: "x" })).rejects.toThrow(/no concepts/);
    expect((await lessonRow(id)).status).toBe("needs_review");
  });

  it("is all or nothing: a bad quiz item leaves the lesson untouched", async () => {
    const id = await draftLesson();
    const broken = makeGraph();
    broken.quizItems[0].conceptId = "c_ghost"; // violates the foreign key to concepts
    await expect(publish(teacher, id, broken)).rejects.toThrow();
    expect((await lessonRow(id)).status).toBe("needs_review");
    expect((await lessonRow(id)).graph_version).toBe(0);
    expect(await concepts(id)).toEqual([]);
    expect(await quizItems(id)).toEqual([]);
  });

  it("rejects an anonymous caller", async () => {
    const id = await draftLesson();
    await expect(
      asService(db, async (tx) =>
        tx.query(`select publish_lesson($1, $2)`, [id, JSON.stringify(makeGraph())]),
      ),
    ).rejects.toThrow(/lesson not found/);
  });
});

describe("publish_lesson: republishing keeps ids and retires what was removed", () => {
  it("bumps the version, retires removed concepts and items, and keeps the rest", async () => {
    const id = await draftLesson();
    await publish(teacher, id, makeGraph());

    // The teacher edits and republishes: Condensation is removed, a new concept is added.
    await db.query(`update lessons set status = 'needs_review' where id = $1`, [id]);
    const next = makeGraph();
    next.concepts = next.concepts.filter((c) => c.id !== "c_condensation");
    next.concepts[1].prerequisites = [];
    next.quizItems = next.quizItems.filter((q) => q.conceptId !== "c_condensation");
    next.concepts.push({
      ...next.concepts[0],
      id: "c_new",
      title: "Runoff",
      order: 2,
      keyTerm: undefined,
    });
    next.concepts.forEach((c, i) => (c.order = i));
    next.quizItems.push({ ...next.quizItems[0], id: "q_new", conceptId: "c_new" });
    const version = await publish(teacher, id, next);
    expect(version).toBe(2);

    const byId = Object.fromEntries((await concepts(id)).map((c) => [c.id, c]));
    expect(byId.c_condensation.retired).toBe(true);
    expect(byId.c_evaporation).toMatchObject({ retired: false, graph_version: 2 });
    expect(byId.c_precipitation).toMatchObject({ retired: false, graph_version: 2 });
    expect(byId.c_new).toMatchObject({ retired: false, title: "Runoff", key_term: null });

    const items = Object.fromEntries((await quizItems(id)).map((q) => [q.id, q]));
    expect(items.q_condensation_1.retired).toBe(true);
    expect(items.q_condensation_2.retired).toBe(true);
    expect(items.q_evaporation_1.retired).toBe(false);
    expect(items.q_new.retired).toBe(false);
  });

  it("un-retires a concept that returns", async () => {
    const id = await draftLesson();
    await publish(teacher, id, makeGraph());
    await db.query(`update lessons set status = 'needs_review' where id = $1`, [id]);
    const without = makeGraph();
    without.concepts = without.concepts.filter((c) => c.id !== "c_precipitation");
    without.quizItems = without.quizItems.filter((q) => q.conceptId !== "c_precipitation");
    await publish(teacher, id, without);
    expect((await concepts(id)).find((c) => c.id === "c_precipitation")?.retired).toBe(true);

    await db.query(`update lessons set status = 'needs_review' where id = $1`, [id]);
    await publish(teacher, id, makeGraph());
    expect((await concepts(id)).find((c) => c.id === "c_precipitation")?.retired).toBe(false);
  });

  it("keeps learner progress on unchanged concepts across a republish", async () => {
    const id = await draftLesson();
    await publish(teacher, id, makeGraph());
    // The learner answers two questions on Evaporation correctly: mastered.
    for (const n of [1, 2]) {
      await db.query(
        `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, correct, layout, occurred_at)
         values ($1, $2, $3, 1, 'quiz_answered', 'c_evaporation', true, 'cards', now() + ($4 || ' seconds')::interval)`,
        [`01PUBLISH000000000000000${n}`, learner, id, String(n)],
      );
    }
    await db.query(`update lessons set status = 'needs_review' where id = $1`, [id]);
    const edited = makeGraph();
    edited.concepts[1].title = "Cloud formation"; // an unrelated edit
    await publish(teacher, id, edited);

    const { rows } = await db.query<{ status: string; attempts: number }>(
      `select status, attempts from concept_mastery where user_id = $1 and concept_id = 'c_evaporation'`,
      [learner],
    );
    expect(rows).toEqual([{ status: "mastered", attempts: 2 }]);
  });

  it("keeps the mastery row of a concept that is retired", async () => {
    const id = await draftLesson();
    await publish(teacher, id, makeGraph());
    await db.query(
      `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, layout, occurred_at)
       values ('01PUBLISH0000000000000RET', $1, $2, 1, 'concept_viewed', 'c_precipitation', 'cards', now())`,
      [learner, id],
    );
    await db.query(`update lessons set status = 'needs_review' where id = $1`, [id]);
    const without = makeGraph();
    without.concepts = without.concepts.filter((c) => c.id !== "c_precipitation");
    without.quizItems = without.quizItems.filter((q) => q.conceptId !== "c_precipitation");
    await publish(teacher, id, without);
    const { rows } = await db.query(
      `select 1 from concept_mastery where user_id = $1 and concept_id = 'c_precipitation'`,
      [learner],
    );
    expect(rows).toHaveLength(1);
  });
});
