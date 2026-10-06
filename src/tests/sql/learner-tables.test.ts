import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db } from "./harness";

let db: Db;
let user: string;
let lesson: string;

beforeAll(async () => {
  db = await createDb();
  user = await createUser(db, "maya");
  lesson = (
    await db.query<{ id: string }>(`insert into lessons (owner_id) values ($1) returning id`, [
      user,
    ])
  ).rows[0].id;
  await db.query(
    `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
     values ('c_1', $1, 1, 0, 'T', 'S')`,
    [lesson],
  );
});

afterAll(async () => {
  await db.close();
});

const event = `insert into learning_events (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
               values ($1, $2, $3, 1, $4, $5, now())`;

describe("learner data tables migration", () => {
  it("applies cleanly with row-level security on every table", async () => {
    const { rows } = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
       where schemaname = 'public'
         and tablename in ('render_profiles', 'learning_events', 'concept_mastery', 'unmet_needs')`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.rowsecurity)).toBe(true);
  });

  it("defaults a profile to private", async () => {
    await db.query(`insert into render_profiles (user_id, profile) values ($1, '{}')`, [user]);
    const { rows } = await db.query<{ share_with_teachers: boolean }>(
      `select share_with_teachers from render_profiles where user_id = $1`,
      [user],
    );
    expect(rows[0].share_with_teachers).toBe(false);
  });

  it("has no diagnosis or disability column on any table", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'public'
         and column_name ~* '(diagnos|disab|condition|adhd|dyslex|autis)'`,
    );
    expect(rows).toEqual([]);
  });

  it("makes event ids idempotent through the primary key", async () => {
    await db.query(event, ["01EVENT0000000000000000001", user, lesson, "lesson_started", "cards"]);
    await expect(
      db.query(event, ["01EVENT0000000000000000001", user, lesson, "lesson_started", "cards"]),
    ).rejects.toThrow(/duplicate key/);
  });

  it("rejects an unknown event type and an unknown layout", async () => {
    await expect(
      db.query(event, ["01EVENT0000000000000000002", user, lesson, "clicked", "cards"]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(event, ["01EVENT0000000000000000003", user, lesson, "lesson_started", "grid"]),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects negative durations", async () => {
    await expect(
      db.query(
        `insert into learning_events (id, user_id, lesson_id, graph_version, type, layout, occurred_at, duration_ms)
         values ('01EVENT0000000000000000004', $1, $2, 1, 'concept_viewed', 'cards', now(), -5)`,
        [user, lesson],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("keeps one mastery row per learner and concept", async () => {
    const insert = `insert into concept_mastery (user_id, lesson_id, concept_id) values ($1, $2, 'c_1')`;
    await db.query(insert, [user, lesson]);
    await expect(db.query(insert, [user, lesson])).rejects.toThrow(/duplicate key/);
  });

  it("ties mastery to a real concept", async () => {
    await expect(
      db.query(
        `insert into concept_mastery (user_id, lesson_id, concept_id) values ($1, $2, 'c_ghost')`,
        [user, lesson],
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it("allows an anonymous unmet need and rejects empty text", async () => {
    await db.query(`insert into unmet_needs (request_text) values ('make the text sing')`);
    await expect(db.query(`insert into unmet_needs (request_text) values ('')`)).rejects.toThrow(
      /check constraint/,
    );
  });
});
