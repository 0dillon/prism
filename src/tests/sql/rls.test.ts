import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, assignLesson, createDb, createUser, type Db } from "./harness";

let db: Db;
let teacher: string; // owns the lessons
let learnerA: string;
let learnerB: string;
let published: string;
let draft: string;
let clip: string;

const RLS = /row-level security/;
const DENIED = /permission denied/;

beforeAll(async () => {
  db = await createDb();
  teacher = await createUser(db, "teacher");
  learnerA = await createUser(db, "learner_a");
  learnerB = await createUser(db, "learner_b");

  const lesson = async (status: string) =>
    (
      await db.query<{ id: string }>(
        `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', $2, 1) returning id`,
        [teacher, status],
      )
    ).rows[0].id;
  published = await lesson("published");
  await assignLesson(db, teacher, published, [learnerA, learnerB]);
  draft = await lesson("needs_review");

  for (const l of [published, draft]) {
    await db.query(
      `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
       values ('c_1', $1, 1, 0, 'T', 'S')`,
      [l],
    );
    await db.query(
      `insert into quiz_items (id, lesson_id, concept_id, type) values ('q_1', $1, 'c_1', 'mcq')`,
      [l],
    );
  }
  await db.query(
    `insert into concept_variants (lesson_id, concept_id, graph_version, reading_level, body, summary)
     values ($1, 'c_1', 1, 'plain', 'b', 's')`,
    [published],
  );
  await db.query(
    `insert into render_profiles (user_id, profile) values ($1, '{"layout":"cards"}'), ($2, '{"layout":"visual"}')`,
    [learnerA, learnerB],
  );
  clip = (
    await db.query<{ id: string }>(
      `insert into sign_clips (gloss, storage_path, source, license) values ('WATER', 'w.mp4', 's', 'l') returning id`,
    )
  ).rows[0].id;
  await db.query(
    `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id, verified, verified_by)
     values ($1, 'c_1', $2, true, $3)`,
    [published, clip, teacher],
  );
  await db.query(
    `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
     values ('c_2', $1, 1, 1, 'T2', 'S2')`,
    [published],
  );
  await db.query(
    `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id) values ($1, 'c_2', $2)`,
    [published, clip],
  );
});

afterAll(async () => {
  await db.close();
});

const count = async (tx: { query: Db["query"] }, sql: string, params: unknown[] = []) =>
  (await tx.query<{ n: number }>(`select count(*)::int as n from (${sql}) t`, params)).rows[0].n;

describe("render_profiles", () => {
  it("lets user A read only their own row, never user B's", async () => {
    const rows = await asUser(
      db,
      learnerA,
      async (tx) =>
        (await tx.query<{ user_id: string }>(`select user_id from render_profiles`)).rows,
    );
    expect(rows).toEqual([{ user_id: learnerA }]);

    const other = await asUser(db, learnerA, (tx) =>
      count(tx, `select 1 from render_profiles where user_id = $1`, [learnerB]),
    );
    expect(other).toBe(0);
  });

  it("lets a user write only their own profile", async () => {
    await asUser(db, learnerA, (tx) =>
      tx.query(`update render_profiles set profile = '{"layout":"reader"}' where user_id = $1`, [
        learnerA,
      ]),
    );
    const touched = await asUser(db, learnerA, (tx) =>
      tx.query(`update render_profiles set profile = '{"hacked":true}' where user_id = $1`, [
        learnerB,
      ]),
    );
    expect(touched.affectedRows).toBe(0);
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(`insert into render_profiles (user_id, profile) values ($1, '{}')`, [teacher]),
      ),
    ).rejects.toThrow(RLS);
  });

  it("keeps profiles private from the lesson owner", async () => {
    const n = await asUser(db, teacher, (tx) => count(tx, `select 1 from render_profiles`));
    expect(n).toBe(0);
  });
});

describe("lessons", () => {
  it("shows the owner their drafts and published lessons", async () => {
    const n = await asUser(db, teacher, (tx) => count(tx, `select 1 from lessons`));
    expect(n).toBe(2);
  });

  it("shows learners published lessons only", async () => {
    const ids = await asUser(db, learnerA, async (tx) =>
      (await tx.query<{ id: string }>(`select id from lessons`)).rows.map((row) => row.id),
    );
    expect(ids).toEqual([published]);
  });

  it("stops non-owners from changing or deleting a lesson", async () => {
    const update = await asUser(db, learnerA, (tx) =>
      tx.query(`update lessons set title = 'pwned' where id = $1`, [published]),
    );
    expect(update.affectedRows).toBe(0);
    const del = await asUser(db, learnerA, (tx) =>
      tx.query(`delete from lessons where id = $1`, [published]),
    );
    expect(del.affectedRows).toBe(0);
  });

  it("lets a user create a lesson only as themselves", async () => {
    await asUser(db, learnerA, (tx) =>
      tx.query(`insert into lessons (owner_id, title) values ($1, 'mine')`, [learnerA]),
    );
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(`insert into lessons (owner_id, title) values ($1, 'forged')`, [teacher]),
      ),
    ).rejects.toThrow(RLS);
  });

  it("stops an owner moving a lesson to someone else", async () => {
    await expect(
      asUser(db, teacher, (tx) =>
        tx.query(`update lessons set owner_id = $1 where id = $2`, [learnerA, draft]),
      ),
    ).rejects.toThrow(RLS);
  });
});

describe("concepts, quiz items, and variants", () => {
  it("lets learners read published content and not drafts", async () => {
    await asUser(db, learnerA, async (tx) => {
      expect(await count(tx, `select 1 from concepts where lesson_id = $1`, [published])).toBe(2);
      expect(await count(tx, `select 1 from quiz_items where lesson_id = $1`, [published])).toBe(1);
      expect(await count(tx, `select 1 from concept_variants`)).toBe(1);
      expect(await count(tx, `select 1 from concepts where lesson_id = $1`, [draft])).toBe(0);
      expect(await count(tx, `select 1 from quiz_items where lesson_id = $1`, [draft])).toBe(0);
    });
  });

  it("lets the owner read their draft content", async () => {
    const n = await asUser(db, teacher, (tx) =>
      count(tx, `select 1 from concepts where lesson_id = $1`, [draft]),
    );
    expect(n).toBe(1);
  });

  it("stops non-owners writing concepts and quiz items", async () => {
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(
          `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
           values ('c_x', $1, 1, 9, 'x', 'x')`,
          [published],
        ),
      ),
    ).rejects.toThrow(RLS);
    const touched = await asUser(db, learnerA, (tx) =>
      tx.query(`update concepts set title = 'pwned' where lesson_id = $1`, [published]),
    );
    expect(touched.affectedRows).toBe(0);
  });

  it("lets the owner write concepts for their own lesson", async () => {
    await asUser(db, teacher, (tx) =>
      tx.query(
        `insert into concepts (id, lesson_id, graph_version, order_index, title, summary)
         values ('c_owner', $1, 1, 5, 'x', 'x')`,
        [draft],
      ),
    );
  });

  it("gives clients no write access to variants", async () => {
    await expect(
      asUser(db, teacher, (tx) =>
        tx.query(
          `insert into concept_variants (lesson_id, concept_id, graph_version, reading_level, body, summary)
           values ($1, 'c_1', 1, 'simple', 'b', 's')`,
          [published],
        ),
      ),
    ).rejects.toThrow(DENIED);
  });
});

describe("learning_events and concept_mastery", () => {
  const insertEvent =
    (id: string, userId: string, lessonId: string) => (tx: { query: Db["query"] }) =>
      tx.query(
        `insert into learning_events (id, user_id, lesson_id, graph_version, type, concept_id, layout, occurred_at)
       values ($1, $2, $3, 1, 'concept_viewed', 'c_1', 'cards', now())`,
        [id, userId, lessonId],
      );

  it("lets a learner append events as themselves for a published lesson", async () => {
    await asUser(db, learnerA, insertEvent("01RLS000000000000000000001", learnerA, published));
  });

  it("rejects an event forged for another user", async () => {
    await expect(
      asUser(db, learnerA, insertEvent("01RLS000000000000000000002", learnerB, published)),
    ).rejects.toThrow(RLS);
  });

  it("rejects an event for a lesson the learner cannot read", async () => {
    await expect(
      asUser(db, learnerA, insertEvent("01RLS000000000000000000003", learnerA, draft)),
    ).rejects.toThrow(RLS);
  });

  it("hides one learner's events and mastery from another", async () => {
    await asUser(db, learnerB, insertEvent("01RLS000000000000000000004", learnerB, published));
    const seenByA = await asUser(
      db,
      learnerA,
      async (tx) =>
        (await tx.query<{ user_id: string }>(`select user_id from learning_events`)).rows,
    );
    expect(seenByA.every((row) => row.user_id === learnerA)).toBe(true);

    const mastery = await asUser(
      db,
      learnerA,
      async (tx) =>
        (await tx.query<{ user_id: string }>(`select user_id from concept_mastery`)).rows,
    );
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((row) => row.user_id === learnerA)).toBe(true);
  });

  it("makes events immutable for clients", async () => {
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(`update learning_events set correct = true where user_id = $1`, [learnerA]),
      ),
    ).rejects.toThrow(DENIED);
    await expect(
      asUser(db, learnerA, (tx) => tx.query(`delete from learning_events`)),
    ).rejects.toThrow(DENIED);
  });

  it("stops clients writing mastery directly", async () => {
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(
          `insert into concept_mastery (user_id, lesson_id, concept_id, status)
           values ($1, $2, 'c_1', 'mastered')`,
          [learnerA, published],
        ),
      ),
    ).rejects.toThrow(DENIED);
  });
});

describe("users_public", () => {
  it("lets a user rename themselves but not become a creator", async () => {
    await asUser(db, learnerA, (tx) =>
      tx.query(`update users_public set display_name = 'Renamed' where id = $1`, [learnerA]),
    );
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(`update users_public set is_creator = true where id = $1`, [learnerA]),
      ),
    ).rejects.toThrow(DENIED);
  });

  it("stops a user renaming someone else", async () => {
    const touched = await asUser(db, learnerA, (tx) =>
      tx.query(`update users_public set display_name = 'x' where id = $1`, [learnerB]),
    );
    expect(touched.affectedRows).toBe(0);
  });
});

describe("sign clips and links", () => {
  it("shows learners only verified links", async () => {
    const rows = await asUser(
      db,
      learnerA,
      async (tx) =>
        (await tx.query<{ concept_id: string }>(`select concept_id from concept_sign_links`)).rows,
    );
    expect(rows).toEqual([{ concept_id: "c_1" }]);
  });

  it("shows the lesson owner every link", async () => {
    const n = await asUser(db, teacher, (tx) => count(tx, `select 1 from concept_sign_links`));
    expect(n).toBe(2);
  });

  it("lets the owner verify a link only as themselves", async () => {
    await expect(
      asUser(db, teacher, (tx) =>
        tx.query(
          `update concept_sign_links set verified = true, verified_by = $1 where concept_id = 'c_2'`,
          [learnerA],
        ),
      ),
    ).rejects.toThrow(RLS);
    await asUser(db, teacher, (tx) =>
      tx.query(
        `update concept_sign_links set verified = true, verified_by = $1 where concept_id = 'c_2'`,
        [teacher],
      ),
    );
    const n = await asUser(db, learnerA, (tx) => count(tx, `select 1 from concept_sign_links`));
    expect(n).toBe(2);
  });

  it("stops learners changing links", async () => {
    const touched = await asUser(db, learnerA, (tx) =>
      tx.query(`update concept_sign_links set verified = false`),
    );
    expect(touched.affectedRows).toBe(0);
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(
          `insert into concept_sign_links (lesson_id, concept_id, sign_clip_id) values ($1, 'c_1', $2)`,
          [published, clip],
        ),
      ),
    ).rejects.toThrow(RLS);
  });

  it("lets signed-in users read the clip library but not edit it", async () => {
    const n = await asUser(db, learnerA, (tx) => count(tx, `select 1 from sign_clips`));
    expect(n).toBe(1);
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(
          `insert into sign_clips (gloss, storage_path, source, license) values ('X','x','s','l')`,
        ),
      ),
    ).rejects.toThrow(DENIED);
  });

  it("lets signed-in users read sign-clips storage objects and nothing else writes", async () => {
    await db.query(`insert into storage.objects (bucket_id, name) values ('sign-clips', 'w.mp4')`);
    const n = await asUser(db, learnerA, (tx) => count(tx, `select 1 from storage.objects`));
    expect(n).toBe(1);
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(`insert into storage.objects (bucket_id, name) values ('sign-clips', 'evil.mp4')`),
      ),
    ).rejects.toThrow(RLS);
  });
});

describe("unmet_needs and pipeline tables", () => {
  it("lets a user log an unmet need but never read any", async () => {
    await asUser(db, learnerA, (tx) =>
      tx.query(`insert into unmet_needs (user_id, request_text) values ($1, 'hologram teacher')`, [
        learnerA,
      ]),
    );
    await expect(
      asUser(db, learnerA, (tx) => count(tx, `select 1 from unmet_needs`)),
    ).rejects.toThrow(DENIED);
    await expect(
      asUser(db, learnerA, (tx) =>
        tx.query(`insert into unmet_needs (user_id, request_text) values ($1, 'forged')`, [
          learnerB,
        ]),
      ),
    ).rejects.toThrow(RLS);
  });

  it("shows ingestion jobs to the lesson owner only", async () => {
    await db.query(`insert into ingestion_jobs (lesson_id) values ($1)`, [draft]);
    expect(await asUser(db, teacher, (tx) => count(tx, `select 1 from ingestion_jobs`))).toBe(1);
    expect(await asUser(db, learnerA, (tx) => count(tx, `select 1 from ingestion_jobs`))).toBe(0);
    await expect(
      asUser(db, teacher, (tx) => tx.query(`update ingestion_jobs set progress = 100`)),
    ).rejects.toThrow(DENIED);
  });
});

describe("anonymous and service access", () => {
  const TABLES = [
    "users_public",
    "lessons",
    "ingestion_jobs",
    "concepts",
    "quiz_items",
    "concept_variants",
    "render_profiles",
    "learning_events",
    "concept_mastery",
    "unmet_needs",
    "sign_clips",
    "concept_sign_links",
  ];

  it.each(TABLES)("denies the anonymous role any access to %s", async (table) => {
    await expect(asAnon(db, (tx) => tx.query(`select * from ${table}`))).rejects.toThrow(DENIED);
  });

  it("lets the service role bypass row-level security", async () => {
    const n = await asService(db, (tx) => count(tx, `select 1 from render_profiles`));
    expect(n).toBe(2);
  });

  it("has at least one policy on every public table", async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select t.tablename from pg_tables t
       where t.schemaname = 'public'
         and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename)`,
    );
    expect(rows).toEqual([]);
  });
});
