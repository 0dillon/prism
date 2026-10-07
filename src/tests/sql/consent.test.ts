import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, assignLesson, createDb, createUser, type Db } from "./harness";

let db: Db;
let teacher: string;
let principal: string;
let adult: string;
let teen: string;
let child: string;
let otherChild: string;
let outsider: string;
let lesson: string;
let room: string;
let orgId: string;

const yearsAgo = (years: number, extraDays = 0) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
};

const status = async (user: string) =>
  (
    await db.query<{ status: string }>(`select status from user_consents where user_id = $1`, [
      user,
    ])
  ).rows[0]?.status;

beforeAll(async () => {
  db = await createDb();
  teacher = await createUser(db, "teacher");
  principal = await createUser(db, "principal");
  outsider = await createUser(db, "outsider");
  adult = await createUser(db, "adult", { birthDate: yearsAgo(30) });
  teen = await createUser(db, "teen", { birthDate: yearsAgo(14) });
  child = await createUser(db, "child", { birthDate: yearsAgo(10) });
  otherChild = await createUser(db, "other_child", { birthDate: yearsAgo(12, 30) });

  orgId = (
    await db.query<{ id: string }>(
      `insert into organizations (name, slug) values ('Oak', 'oak') returning id`,
    )
  ).rows[0].id;
  await db.query(
    `insert into org_memberships (org_id, user_id, role) values ($1, $2, 'teacher'), ($1, $3, 'principal')`,
    [orgId, teacher, principal],
  );
  lesson = (
    await db.query<{ id: string }>(
      `insert into lessons (owner_id, title, status, graph_version) values ($1, 'L', 'published', 1) returning id`,
      [teacher],
    )
  ).rows[0].id;
  await assignLesson(db, teacher, lesson, [adult, teen, child]);
  room = (await db.query<{ id: string }>(`select id from classrooms limit 1`)).rows[0].id;
  // The classroom made by the helper is in its own school; put it in this one for the roles below.
  await db.query(`update classrooms set org_id = $1 where id = $2`, [orgId, room]);
});

afterAll(async () => {
  await db.close();
});

describe("sign-up", () => {
  it("starts an under-13 account as pending, and everyone else as not requiring consent", async () => {
    expect(await status(child)).toBe("pending");
    expect(await status(otherChild)).toBe("pending");
    expect(await status(teen)).toBe("not_required");
    expect(await status(adult)).toBe("not_required");
  });

  it("treats someone who turned 13 today as old enough, and someone a day short as not", async () => {
    const today = await createUser(db, "thirteen_today", { birthDate: yearsAgo(13) });
    const tomorrow = await createUser(db, "almost_thirteen", { birthDate: yearsAgo(13, 1) });
    expect(await status(today)).toBe("not_required");
    expect(await status(tomorrow)).toBe("pending");
  });

  it("leaves an account with no date of birth, or an unreadable one, unrestricted", async () => {
    const none = await createUser(db, "no_birth_date");
    expect(await status(none)).toBeUndefined();
    const garbage = await db.query<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data) values ('garbage@example.test', '{"birth_date":"not a date"}') returning id`,
    );
    expect(await status(garbage.rows[0].id)).toBeUndefined();
    const future = await createUser(db, "from_the_future", { birthDate: yearsAgo(-5) });
    expect(await status(future)).toBeUndefined();
  });
});

describe("an inactive account", () => {
  const lessons = (user: string) =>
    asUser(
      db,
      user,
      async (tx) => (await tx.query(`select id from lessons where id = $1`, [lesson])).rows.length,
    );

  it("cannot read an assigned lesson, while an adult in the same class can", async () => {
    expect(await lessons(child)).toBe(0);
    expect(await lessons(adult)).toBe(1);
    expect(await lessons(teen)).toBe(1);
  });

  it("cannot record learning events", async () => {
    await expect(
      asUser(db, child, (tx) =>
        tx.query(
          `insert into learning_events (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
           values ('01CONSENT0000000000000000A1', $1, $2, 1, 'lesson_started', 'cards', now())`,
          [child, lesson],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot join a class with a code", async () => {
    const code = (await db.query<{ join_code: string }>(`select join_code from classrooms limit 1`))
      .rows[0].join_code;
    await expect(
      asUser(db, otherChild, (tx) => tx.query(`select public.join_classroom($1)`, [code])),
    ).rejects.toThrow(/parent or guardian needs to agree/);
  });

  it("can still read its own consent status, and nothing else about it", async () => {
    const own = await asUser(db, child, (tx) =>
      tx.query(`select user_id, status from user_consents`),
    );
    expect(own.rows).toEqual([expect.objectContaining({ user_id: child, status: "pending" })]);
    for (const secret of ["birth_date", "guardian_email", "token_hash"]) {
      await expect(
        asUser(db, child, (tx) => tx.query(`select ${secret} from user_consents`)),
      ).rejects.toThrow(/permission denied/);
    }
    const others = await asUser(db, teen, (tx) =>
      tx.query<{ user_id: string }>(`select user_id from user_consents`),
    );
    expect(others.rows.map((r) => r.user_id)).toEqual([teen]);
  });
});

describe("guardian consent", () => {
  const request = (user: string, email: string) =>
    asUser(
      db,
      user,
      async (tx) =>
        (await tx.query<{ t: string }>(`select public.request_guardian_consent($1) as t`, [email]))
          .rows[0].t,
    );
  const grant = (token: string) =>
    asService(
      db,
      async (tx) =>
        (await tx.query<{ u: string }>(`select public.grant_guardian_consent($1) as u`, [token]))
          .rows[0].u,
    );

  it("gives the server a token, and keeps the address and only a hash of the token", async () => {
    const token = await request(child, "  Parent@Example.test ");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.query<{ guardian_email: string; token_hash: Uint8Array }>(
      `select guardian_email, token_hash from user_consents where user_id = $1`,
      [child],
    );
    expect(row.rows[0].guardian_email).toBe("parent@example.test");
    expect(Buffer.from(row.rows[0].token_hash).toString("hex")).not.toBe(token);
  });

  it("makes the account active once the guardian agrees", async () => {
    const token = await request(child, "parent@example.test");
    expect(await grant(token)).toBe(child);
    expect(await status(child)).toBe("granted");
    const row = await db.query(
      `select granted_by, token_hash from user_consents where user_id = $1`,
      [child],
    );
    expect(row.rows).toEqual([{ granted_by: "guardian", token_hash: null }]);
    const seen = await asUser(db, child, (tx) =>
      tx.query(`select id from lessons where id = $1`, [lesson]),
    );
    expect(seen.rows).toHaveLength(1);
    await asUser(db, child, (tx) =>
      tx.query(
        `insert into learning_events (id, user_id, lesson_id, graph_version, type, layout, occurred_at)
         values ('01CONSENT0000000000000000A2', $1, $2, 1, 'lesson_started', 'cards', now())`,
        [child, lesson],
      ),
    );
  });

  it("works once only, and not after 14 days", async () => {
    const token = await request(otherChild, "parent@example.test");
    await db.query(
      `update user_consents set token_expires_at = now() - interval '1 second' where user_id = $1`,
      [otherChild],
    );
    await expect(grant(token)).rejects.toThrow(/not valid any more/);
    const fresh = await request(otherChild, "parent@example.test");
    await grant(fresh);
    await expect(grant(fresh)).rejects.toThrow(/not valid any more/);
  });

  it("refuses an unknown token", async () => {
    await expect(grant("0".repeat(64))).rejects.toThrow(/not valid any more/);
    await expect(grant("")).rejects.toThrow(/not valid any more/);
  });

  it("is not something a client can call, so a child cannot agree for themselves", async () => {
    const pendingChild = await createUser(db, "pending_self", { birthDate: yearsAgo(9) });
    const token = await request(pendingChild, "parent@example.test");
    await expect(
      asUser(db, pendingChild, (tx) =>
        tx.query(`select public.grant_guardian_consent($1)`, [token]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asAnon(db, (tx) => tx.query(`select public.grant_guardian_consent($1)`, [token])),
    ).rejects.toThrow(/permission denied/);
    expect(await status(pendingChild)).toBe("pending");
  });

  it("is only asked for by an account that needs it", async () => {
    await expect(request(adult, "parent@example.test")).rejects.toThrow(/does not need consent/);
  });

  it("records who agreed in the school's audit log", async () => {
    const log = await db.query(
      `select metadata from audit_log where action = 'consent.granted' and org_id = $1`,
      [orgId],
    );
    expect(log.rows).toEqual([]); // the child had no school membership, so no school sees an entry
    await db.query(`insert into org_memberships values ($1, $2, 'student', now())`, [
      orgId,
      otherChild,
    ]);
    const again = await createUser(db, "audited", { birthDate: yearsAgo(8) });
    await db.query(`insert into org_memberships values ($1, $2, 'student', now())`, [orgId, again]);
    await grant(await request(again, "p@example.test"));
    const entry = await db.query(
      `select metadata, actor_id from audit_log where action = 'consent.granted' and target = $1`,
      [again],
    );
    expect(entry.rows).toEqual([{ metadata: { by: "guardian" }, actor_id: null }]);
  });
});

describe("consent recorded by the school", () => {
  let pupil: string;

  beforeAll(async () => {
    pupil = await createUser(db, "pupil", { birthDate: yearsAgo(11) });
    await db.query(`insert into enrollments values ($1, $2)`, [room, pupil]);
  });

  const record = (user: string, student: string) =>
    asUser(db, user, (tx) => tx.query(`select public.record_school_consent($1)`, [student]));

  it("lets the class's teacher see who is waiting", async () => {
    const waiting = await asUser(db, teacher, async (tx) =>
      (
        await tx.query<{ student_id: string }>(`select * from pending_consents($1)`, [room])
      ).rows.map((r) => r.student_id),
    );
    expect(waiting).toEqual([pupil]);
  });

  it("shows the list to the principal and to no one else", async () => {
    const count = (user: string) =>
      asUser(
        db,
        user,
        async (tx) => (await tx.query(`select * from pending_consents($1)`, [room])).rows.length,
      );
    expect(await count(principal)).toBe(1);
    expect(await count(outsider)).toBe(0);
    expect(await count(pupil)).toBe(0);
  });

  it("refuses someone who is not this student's teacher or principal", async () => {
    await expect(record(outsider, pupil)).rejects.toThrow(/only the teacher or principal/);
    await expect(record(pupil, pupil)).rejects.toThrow(/only the teacher or principal/);
    expect(await status(pupil)).toBe("pending");
  });

  it("lets the teacher record it, and makes the account active", async () => {
    await record(teacher, pupil);
    expect(await status(pupil)).toBe("granted");
    const row = await db.query(`select granted_by from user_consents where user_id = $1`, [pupil]);
    expect(row.rows).toEqual([{ granted_by: "school" }]);
    const log = await db.query(
      `select actor_id, metadata from audit_log where action = 'consent.recorded' and target = $1`,
      [pupil],
    );
    expect(log.rows).toEqual([{ actor_id: teacher, metadata: { by: "school" } }]);
  });

  it("is refused for an account that does not need it", async () => {
    await expect(record(teacher, pupil)).rejects.toThrow(/does not need consent/);
  });
});

describe("data requests", () => {
  const ask = (user: string, kind: string) =>
    asUser(db, user, (tx) =>
      tx.query(`insert into data_requests (user_id, kind) values ($1, $2)`, [user, kind]),
    );

  it("lets a person ask for an export or a deletion, and read their own requests", async () => {
    await ask(adult, "export");
    await ask(adult, "delete");
    const own = await asUser(db, adult, (tx) =>
      tx.query(`select kind, status from data_requests order by kind`),
    );
    expect(own.rows).toEqual([
      { kind: "delete", status: "requested" },
      { kind: "export", status: "requested" },
    ]);
    const other = await asUser(db, teen, (tx) => tx.query(`select 1 from data_requests`));
    expect(other.rows).toHaveLength(0);
  });

  it("allows only one open deletion request at a time", async () => {
    await expect(ask(adult, "delete")).rejects.toThrow(/duplicate key/);
    await ask(adult, "export");
  });

  it("does not let someone ask in another person's name, or mark a request done", async () => {
    await expect(
      asUser(db, teen, (tx) =>
        tx.query(`insert into data_requests (user_id, kind) values ($1, 'delete')`, [adult]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asUser(db, adult, (tx) => tx.query(`update data_requests set status = 'completed'`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("removes a person's records with the person", async () => {
    const leaving = await createUser(db, "leaving", { birthDate: yearsAgo(40) });
    await ask(leaving, "delete");
    await db.query(`delete from auth.users where id = $1`, [leaving]);
    const rows = await db.query(`select 1 from data_requests where user_id = $1`, [leaving]);
    expect(rows.rows).toHaveLength(0);
  });
});
