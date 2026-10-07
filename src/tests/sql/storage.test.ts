import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, assignLesson, createDb, createUser, type Db } from "./harness";

let db: Db;
let owner: string;
let other: string;
let published: string;
let draft: string;

const RLS = /row-level security/;

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner");
  other = await createUser(db, "other");
  const lesson = async (status: string) =>
    (
      await db.query<{ id: string }>(
        `insert into lessons (owner_id, status) values ($1, $2) returning id`,
        [owner, status],
      )
    ).rows[0].id;
  published = await lesson("published");
  await assignLesson(db, owner, published, [other]);
  draft = await lesson("needs_review");
});

afterAll(async () => {
  await db.close();
});

const put = (bucket: string, name: string) => (tx: { query: Db["query"] }) =>
  tx.query(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]);

const visible = async (user: string, bucket: string) =>
  asUser(db, user, async (tx) =>
    (
      await tx.query<{ name: string }>(
        `select name from storage.objects where bucket_id = $1 order by name`,
        [bucket],
      )
    ).rows.map((row) => row.name),
  );

describe("storage buckets", () => {
  it("creates private sources and lesson-media buckets with size limits", async () => {
    const { rows } = await db.query<{ id: string; public: boolean; file_size_limit: string }>(
      `select id, public, file_size_limit::text from storage.buckets
       where id in ('sources', 'lesson-media') order by id`,
    );
    expect(rows).toEqual([
      { id: "lesson-media", public: false, file_size_limit: "10485760" },
      { id: "sources", public: false, file_size_limit: "52428800" },
    ]);
  });

  it("makes every bucket private", async () => {
    const { rows } = await db.query<{ id: string }>(`select id from storage.buckets where public`);
    expect(rows).toEqual([]);
  });
});

describe("sources bucket policies", () => {
  it("lets a user upload into their own folder", async () => {
    await asUser(db, owner, put("sources", `${owner}/${published}/source.pdf`));
  });

  it("stops a user uploading into someone else's folder", async () => {
    await expect(
      asUser(db, other, put("sources", `${owner}/${published}/evil.pdf`)),
    ).rejects.toThrow(RLS);
  });

  it("stops a user writing at the bucket root", async () => {
    await expect(asUser(db, owner, put("sources", "loose.pdf"))).rejects.toThrow(RLS);
  });

  it("hides one user's sources from another", async () => {
    expect(await visible(owner, "sources")).toEqual([`${owner}/${published}/source.pdf`]);
    expect(await visible(other, "sources")).toEqual([]);
  });

  it("lets the owner delete their source and not another user's", async () => {
    await asUser(db, other, put("sources", `${other}/x/source.txt`));
    const denied = await asUser(db, owner, (tx) =>
      tx.query(`delete from storage.objects where name = $1`, [`${other}/x/source.txt`]),
    );
    expect(denied.affectedRows).toBe(0);
    const allowed = await asUser(db, other, (tx) =>
      tx.query(`delete from storage.objects where name = $1`, [`${other}/x/source.txt`]),
    );
    expect(allowed.affectedRows).toBe(1);
  });
});

describe("lesson-media bucket policies", () => {
  it("lets the lesson owner upload media for their lesson", async () => {
    await asUser(db, owner, put("lesson-media", `${published}/cover.png`));
    await asUser(db, owner, put("lesson-media", `${draft}/draft.png`));
  });

  it("stops others uploading media for a lesson they do not own", async () => {
    await expect(asUser(db, other, put("lesson-media", `${published}/evil.png`))).rejects.toThrow(
      RLS,
    );
  });

  it("rejects paths whose first folder is not a lesson id", async () => {
    await expect(asUser(db, owner, put("lesson-media", "not-a-uuid/x.png"))).rejects.toThrow(RLS);
    await expect(asUser(db, owner, put("lesson-media", "loose.png"))).rejects.toThrow(RLS);
  });

  it("lets learners read media for published lessons only", async () => {
    expect(await visible(other, "lesson-media")).toEqual([`${published}/cover.png`]);
    expect(await visible(owner, "lesson-media")).toEqual(
      [`${draft}/draft.png`, `${published}/cover.png`].sort(),
    );
  });

  it("does not raise on odd paths when listing", async () => {
    await db.query(
      `insert into storage.objects (bucket_id, name) values ('lesson-media', 'junk/x.png')`,
    );
    expect(await visible(other, "lesson-media")).toEqual([`${published}/cover.png`]);
  });
});
