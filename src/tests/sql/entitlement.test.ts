import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, assignLesson, createDb, createUser, type Db } from "./harness";

let db: Db;
let owner: string;
let creator: string;
let buyer: string;
let stranger: string;
let enrolled: string;
let assigned: string;
let paidLesson: string;
let previewLesson: string;
let privateLesson: string;
let draftAssigned: string;
let courseId: string;

const RLS = /row-level security/;
const DENIED = /permission denied/;

const lesson = async (ownerId: string, status = "published") =>
  (
    await db.query<{ id: string }>(
      `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', $2, 1) returning id`,
      [ownerId, status],
    )
  ).rows[0].id;

const entitled = (user: string, lessonId: string) =>
  asUser(
    db,
    user,
    async (tx) =>
      (await tx.query<{ ok: boolean }>(`select public.is_entitled($1, $2) as ok`, [user, lessonId]))
        .rows[0].ok,
  );

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner");
  creator = await createUser(db, "creator");
  buyer = await createUser(db, "buyer");
  stranger = await createUser(db, "stranger");
  enrolled = await createUser(db, "enrolled");

  assigned = await lesson(owner);
  draftAssigned = await lesson(owner, "needs_review");
  await assignLesson(db, owner, assigned, [enrolled]);
  await db.query(
    `insert into assignments (classroom_id, lesson_id)
     select classroom_id, $1 from assignments where lesson_id = $2`,
    [draftAssigned, assigned],
  );

  paidLesson = await lesson(creator);
  previewLesson = await lesson(creator);
  privateLesson = await lesson(creator);
  courseId = (
    await db.query<{ id: string }>(
      `insert into courses (creator_id, title, slug, price_cents, status)
       values ($1, 'Course', 'course', 500, 'published') returning id`,
      [creator],
    )
  ).rows[0].id;
  await db.query(
    `insert into course_lessons (course_id, lesson_id, order_index, is_preview)
     values ($1, $2, 0, true), ($1, $3, 1, false)`,
    [courseId, previewLesson, paidLesson],
  );
  await db.query(
    `insert into purchases (buyer_id, course_id, amount_cents, status) values ($1, $2, 500, 'paid')`,
    [buyer, courseId],
  );
});

afterAll(async () => {
  await db.close();
});

describe("is_entitled", () => {
  it("is true for the owner, whatever the status", async () => {
    expect(await entitled(owner, assigned)).toBe(true);
    expect(await entitled(owner, draftAssigned)).toBe(true);
  });

  it("is true for a student enrolled in a classroom the lesson is assigned to", async () => {
    expect(await entitled(enrolled, assigned)).toBe(true);
  });

  it("is true for a buyer with a paid purchase of a course containing the lesson", async () => {
    expect(await entitled(buyer, paidLesson)).toBe(true);
  });

  it("is true for the free preview lesson of a published course, for anyone", async () => {
    expect(await entitled(stranger, previewLesson)).toBe(true);
  });

  it("is false for a published lesson the user has no route to", async () => {
    expect(await entitled(stranger, assigned)).toBe(false);
    expect(await entitled(stranger, paidLesson)).toBe(false);
    expect(await entitled(stranger, privateLesson)).toBe(false);
  });

  it("is false for a draft, even when it is assigned to the student's classroom", async () => {
    expect(await entitled(enrolled, draftAssigned)).toBe(false);
  });

  it("ends when a purchase is refunded, and while it is only pending", async () => {
    await asService(db, (tx) => tx.query(`update purchases set status = 'refunded'`));
    expect(await entitled(buyer, paidLesson)).toBe(false);
    await asService(db, (tx) => tx.query(`update purchases set status = 'pending'`));
    expect(await entitled(buyer, paidLesson)).toBe(false);
    await asService(db, (tx) => tx.query(`update purchases set status = 'paid'`));
    expect(await entitled(buyer, paidLesson)).toBe(true);
  });

  it("ends when the course is suspended, and the preview ends with the listing", async () => {
    await asService(db, (tx) => tx.query(`update courses set status = 'suspended'`));
    expect(await entitled(buyer, paidLesson)).toBe(false);
    expect(await entitled(stranger, previewLesson)).toBe(false);
    await asService(db, (tx) => tx.query(`update courses set status = 'published'`));
    expect(await entitled(buyer, paidLesson)).toBe(true);
  });

  it("only answers for the caller", async () => {
    const answer = await asUser(
      db,
      stranger,
      async (tx) =>
        (
          await tx.query<{ ok: boolean }>(`select public.is_entitled($1, $2) as ok`, [
            owner,
            assigned,
          ])
        ).rows[0].ok,
    );
    expect(answer).toBe(false);
  });
});

describe("lesson reads follow entitlement", () => {
  const visible = (user: string) =>
    asUser(db, user, async (tx) =>
      (await tx.query<{ id: string }>(`select id from lessons order by id`)).rows.map((r) => r.id),
    );

  it("shows a student only what is assigned to them", async () => {
    expect(await visible(enrolled)).toEqual([assigned, previewLesson].sort());
  });

  it("shows a buyer their course and the preview", async () => {
    expect(await visible(buyer)).toEqual([paidLesson, previewLesson].sort());
  });

  it("shows a stranger only the preview", async () => {
    expect(await visible(stranger)).toEqual([previewLesson]);
  });
});

describe("marketplace tables", () => {
  it("lists published courses to anyone, and draft ones to nobody but the creator", async () => {
    await asService(db, (tx) =>
      tx.query(`insert into courses (creator_id, title, slug) values ($1, 'Draft', 'draft')`, [
        creator,
      ]),
    );
    const slugs = (rows: { slug: string }[]) => rows.map((r) => r.slug);
    const anon = await asAnon(db, (tx) => tx.query<{ slug: string }>(`select slug from courses`));
    expect(slugs(anon.rows)).toEqual(["course"]);
    const mine = await asUser(db, creator, (tx) =>
      tx.query<{ slug: string }>(`select slug from courses order by slug`),
    );
    expect(slugs(mine.rows)).toEqual(["course", "draft"]);
    const other = await asUser(db, stranger, (tx) =>
      tx.query<{ slug: string }>(`select slug from courses`),
    );
    expect(slugs(other.rows)).toEqual(["course"]);
  });

  it("lets the buyer and the course's creator read a purchase, and nobody else", async () => {
    const n = (user: string) =>
      asUser(db, user, (tx) =>
        tx.query<{ n: number }>(`select count(*)::int n from purchases`),
      ).then((r) => r.rows[0].n);
    expect(await n(buyer)).toBe(1);
    expect(await n(creator)).toBe(1);
    expect(await n(stranger)).toBe(0);
  });

  it("does not let a client write a purchase or a payout account", async () => {
    await expect(
      asUser(db, stranger, (tx) =>
        tx.query(
          `insert into purchases (buyer_id, course_id, amount_cents, status) values ($1, $2, 0, 'paid')`,
          [stranger, courseId],
        ),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      asUser(db, creator, (tx) =>
        tx.query(`insert into creator_accounts (user_id, onboarding_complete) values ($1, true)`, [
          creator,
        ]),
      ),
    ).rejects.toThrow(DENIED);
  });

  it("lets a creator add only their own lessons to their own course", async () => {
    await expect(
      asUser(db, creator, (tx) =>
        tx.query(
          `insert into course_lessons (course_id, lesson_id, order_index) values ($1, $2, 5)`,
          [courseId, assigned],
        ),
      ),
    ).rejects.toThrow(RLS);
    await expect(
      asUser(db, stranger, (tx) =>
        tx.query(
          `insert into course_lessons (course_id, lesson_id, order_index) values ($1, $2, 5)`,
          [courseId, privateLesson],
        ),
      ),
    ).rejects.toThrow(RLS);
  });

  it("will not list a course whose cover image has no description", async () => {
    await expect(
      asService(db, (tx) =>
        tx.query(
          `insert into courses (creator_id, title, slug, status, cover_path)
           values ($1, 'Pic', 'pic', 'published', 'c.png')`,
          [creator],
        ),
      ),
    ).rejects.toThrow(/check/);
  });
});
