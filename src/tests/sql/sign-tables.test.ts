import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createUser, type Db } from "./harness";

let db: Db;
let user: string;
let lesson: string;
let clip: string;

beforeAll(async () => {
  db = await createDb();
  user = await createUser(db, "sofia");
  lesson = (
    await db.query<{ id: string }>(`insert into lessons (owner_id) values ($1) returning id`, [
      user,
    ])
  ).rows[0].id;
  await db.query(
    `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
     values ('c_1', $1, 1, 0, 'T', 'S'), ('c_2', $1, 1, 1, 'T2', 'S2')`,
    [lesson],
  );
  clip = (
    await db.query<{ id: string }>(
      `insert into sign_clips (gloss, storage_path, source, license, signer_credit)
       values ('WATER', 'asl/water.mp4', 'recorded for Prism', 'CC-BY-4.0', 'A. Signer') returning id`,
    )
  ).rows[0].id;
});

afterAll(async () => {
  await db.close();
});

describe("sign clip tables migration", () => {
  it("creates a private sign-clips bucket", async () => {
    const { rows } = await db.query<{ id: string; public: boolean }>(
      `select id, public from storage.buckets where id = 'sign-clips'`,
    );
    expect(rows).toEqual([{ id: "sign-clips", public: false }]);
  });

  it("enables row-level security on both tables", async () => {
    const { rows } = await db.query<{ rowsecurity: boolean }>(
      `select rowsecurity from pg_tables
       where schemaname = 'public' and tablename in ('sign_clips', 'concept_sign_links')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.rowsecurity)).toBe(true);
  });

  it("keeps one clip per gloss and language", async () => {
    await expect(
      db.query(
        `insert into sign_clips (gloss, storage_path, source, license) values ('WATER', 'x', 's', 'l')`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("only supports ASL in v1", async () => {
    await expect(
      db.query(
        `insert into sign_clips (gloss, language, storage_path, source, license)
         values ('RAIN', 'bfi', 'x', 's', 'l')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("starts every link unverified", async () => {
    const { rows } = await db.query<{ verified: boolean; verified_by: string | null }>(
      `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id)
       values ($1, 'c_1', $2) returning verified, verified_by`,
      [lesson, clip],
    );
    expect(rows[0]).toEqual({ verified: false, verified_by: null });
  });

  it("requires a verifier on a verified link", async () => {
    await expect(
      db.query(
        `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id, verified)
         values ($1, 'c_2', $2, true)`,
        [lesson, clip],
      ),
    ).rejects.toThrow(/check constraint/);
    await db.query(
      `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id, verified, verified_by)
       values ($1, 'c_2', $2, true, $3)`,
      [lesson, clip, user],
    );
  });

  it("allows one link per concept and ties links to a real concept", async () => {
    await expect(
      db.query(
        `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id) values ($1, 'c_1', $2)`,
        [lesson, clip],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      db.query(
        `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id) values ($1, 'c_ghost', $2)`,
        [lesson, clip],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
