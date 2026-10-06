import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db } from "./harness";

let db: Db;

beforeAll(async () => {
  db = await createDb();
});

afterAll(async () => {
  await db.close();
});

const CORE_TABLES = [
  "users_public",
  "lessons",
  "ingestion_jobs",
  "concepts",
  "quiz_items",
  "concept_variants",
];

describe("core content tables migration", () => {
  it("applies cleanly and creates every table", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    );
    const names = rows.map((row) => row.tablename);
    for (const table of CORE_TABLES) expect(names).toContain(table);
  });

  it("enables row-level security on every public table", async () => {
    const { rows } = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables where schemaname = 'public'`,
    );
    for (const row of rows) expect([row.tablename, row.rowsecurity]).toEqual([row.tablename, true]);
  });

  it("creates a users_public row when an auth user signs up", async () => {
    const id = await createUser(db, "amara");
    const { rows } = await db.query<{ display_name: string; is_creator: boolean }>(
      `select display_name, is_creator from users_public where id = $1`,
      [id],
    );
    expect(rows).toEqual([{ display_name: "amara", is_creator: false }]);
  });

  it("falls back to the email local part for the display name", async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into auth.users (email) values ('priya@example.test') returning id`,
    );
    const profile = await db.query<{ display_name: string }>(
      `select display_name from users_public where id = $1`,
      [rows[0].id],
    );
    expect(profile.rows[0].display_name).toBe("priya");
  });

  it("defaults a new lesson to uploading with graph version 0", async () => {
    const owner = await createUser(db, "daniel");
    const { rows } = await db.query<{ status: string; graph_version: number }>(
      `insert into lessons (owner_id, title) values ($1, 'Biology') returning status, graph_version`,
      [owner],
    );
    expect(rows[0]).toEqual({ status: "uploading", graph_version: 0 });
  });

  it("rejects an unknown lesson status and an unknown source type", async () => {
    const owner = await createUser(db, "tunde");
    await expect(
      db.query(`insert into lessons (owner_id, status) values ($1, 'archived')`, [owner]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(`insert into lessons (owner_id, source_type) values ($1, 'mp4')`, [owner]),
    ).rejects.toThrow(/check constraint/);
  });

  it("keeps concept ids unique per lesson and ties quiz items to a real concept", async () => {
    const owner = await createUser(db, "maya");
    const lesson = (
      await db.query<{ id: string }>(`insert into lessons (owner_id) values ($1) returning id`, [
        owner,
      ])
    ).rows[0].id;
    await db.query(
      `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
       values ('c_1', $1, 1, 0, 'Title', 'Summary')`,
      [lesson],
    );
    await expect(
      db.query(
        `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
         values ('c_1', $1, 1, 1, 'Dup', 'Dup')`,
        [lesson],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.query(
        `insert into quiz_items (id, lesson_id, concept_id, type) values ('q_1', $1, 'c_missing', 'mcq')`,
        [lesson],
      ),
    ).rejects.toThrow(/foreign key/);
    await db.query(
      `insert into quiz_items (id, lesson_id, concept_id, type) values ('q_1', $1, 'c_1', 'mcq')`,
      [lesson],
    );
  });

  it("allows one cached variant per concept, version and reading level", async () => {
    const owner = await createUser(db, "leo");
    const lesson = (
      await db.query<{ id: string }>(`insert into lessons (owner_id) values ($1) returning id`, [
        owner,
      ])
    ).rows[0].id;
    await db.query(
      `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
       values ('c_1', $1, 1, 0, 'T', 'S')`,
      [lesson],
    );
    const insert = `insert into concept_variants (lesson_id, concept_id, graph_version, reading_level, body, summary)
                    values ($1, 'c_1', 1, $2, 'body', 'summary')`;
    await db.query(insert, [lesson, "plain"]);
    await db.query(insert, [lesson, "simple"]);
    await expect(db.query(insert, [lesson, "plain"])).rejects.toThrow(/duplicate key/);
    await expect(db.query(insert, [lesson, "original"])).rejects.toThrow(/check constraint/);
  });

  it("deletes a lesson's concepts, quiz items and jobs with it", async () => {
    const owner = await createUser(db, "sofia");
    const lesson = (
      await db.query<{ id: string }>(`insert into lessons (owner_id) values ($1) returning id`, [
        owner,
      ])
    ).rows[0].id;
    await db.query(
      `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
       values ('c_1', $1, 1, 0, 'T', 'S')`,
      [lesson],
    );
    await db.query(`insert into ingestion_jobs (lesson_id) values ($1)`, [lesson]);
    await db.query(`delete from lessons where id = $1`, [lesson]);
    for (const table of ["concepts", "ingestion_jobs"]) {
      const { rows } = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where lesson_id = $1`,
        [lesson],
      );
      expect(rows[0].n).toBe(0);
    }
  });
});
