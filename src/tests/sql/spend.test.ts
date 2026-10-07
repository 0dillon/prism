import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let principal: string;
let teacher: string;
let outsider: string;
let orgId: string;
let otherOrg: string;

const RLS = /row-level security/;
const DENIED = /permission denied/;

beforeAll(async () => {
  db = await createDb();
  principal = await createUser(db, "principal");
  teacher = await createUser(db, "teacher");
  outsider = await createUser(db, "outsider");
  const org = async (slug: string) =>
    (
      await db.query<{ id: string }>(
        `insert into organizations (name, slug) values ($1, $1) returning id`,
        [slug],
      )
    ).rows[0].id;
  orgId = await org("oak");
  otherOrg = await org("elm");
  await db.query(
    `insert into org_memberships (org_id, user_id, role) values ($1, $2, 'principal'), ($1, $3, 'teacher'), ($4, $5, 'teacher')`,
    [orgId, principal, teacher, otherOrg, outsider],
  );
});

afterAll(async () => {
  await db.close();
});

async function job(owner: string, org: string | null, cost: number, createdAt = "now()") {
  const lesson = (
    await db.query<{ id: string }>(
      `insert into lessons (owner_id, org_id, title, status) values ($1, $2, 'L', 'needs_review') returning id`,
      [owner, org],
    )
  ).rows[0].id;
  await db.query(
    `insert into ingestion_jobs (lesson_id, stage, cost_usd, created_at) values ($1, 'done', $2, ${createdAt})`,
    [lesson, cost],
  );
}

const spend = (user: string, org = orgId) =>
  asUser(
    db,
    user,
    async (tx) =>
      (
        await tx.query<{ cap_usd: string | null; spent_usd: string }>(
          `select * from org_spend($1)`,
          [org],
        )
      ).rows[0],
  );

describe("org_spend", () => {
  it("is zero with no cap before anything is spent", async () => {
    expect(await spend(principal)).toEqual({ cap_usd: null, spent_usd: "0" });
  });

  it("adds up this month's ingestion cost for lessons made for the organization", async () => {
    await job(teacher, orgId, 0.25);
    await job(teacher, orgId, 0.5);
    expect(Number((await spend(principal)).spent_usd)).toBeCloseTo(0.75, 6);
  });

  it("leaves out other organizations, lessons with no organization, and earlier months", async () => {
    await job(outsider, otherOrg, 10);
    await job(teacher, null, 10);
    await job(teacher, orgId, 10, "date_trunc('month', now()) - interval '1 day'");
    expect(Number((await spend(principal)).spent_usd)).toBeCloseTo(0.75, 6);
  });

  it("reports the cap the principal set", async () => {
    await asUser(db, principal, (tx) =>
      tx.query(`update organizations set monthly_spend_cap_usd = 5 where id = $1`, [orgId]),
    );
    expect(Number((await spend(principal)).cap_usd)).toBe(5);
  });

  it("is for the principal and the server only", async () => {
    await expect(spend(teacher)).rejects.toThrow(/only the principal/);
    await expect(spend(outsider)).rejects.toThrow(/only the principal/);
    const asServer = await asService(
      db,
      async (tx) =>
        (await tx.query<{ spent_usd: string }>(`select * from org_spend($1)`, [orgId])).rows[0],
    );
    expect(Number(asServer.spent_usd)).toBeCloseTo(0.75, 6);
  });
});

describe("organization editing", () => {
  it("lets the principal change the name and the cap, and nothing else", async () => {
    const ok = await asUser(db, principal, (tx) =>
      tx.query(
        `update organizations set name = 'Oak School', monthly_spend_cap_usd = 20 where id = $1`,
        [orgId],
      ),
    );
    expect(ok.affectedRows).toBe(1);
    for (const column of ["slug = 'new'", `created_by = '${principal}'`]) {
      await expect(
        asUser(db, principal, (tx) =>
          tx.query(`update organizations set ${column} where id = $1`, [orgId]),
        ),
      ).rejects.toThrow(DENIED);
    }
  });

  it("does not let a teacher change the cap", async () => {
    const result = await asUser(db, teacher, (tx) =>
      tx.query(`update organizations set monthly_spend_cap_usd = 1000 where id = $1`, [orgId]),
    );
    expect(result.affectedRows).toBe(0);
  });

  it("refuses a negative cap", async () => {
    await expect(
      asUser(db, principal, (tx) =>
        tx.query(`update organizations set monthly_spend_cap_usd = -1 where id = $1`, [orgId]),
      ),
    ).rejects.toThrow(/check/);
  });
});

describe("lessons made for an organization", () => {
  const insert = (user: string, org: string | null) =>
    asUser(db, user, (tx) =>
      tx.query(`insert into lessons (owner_id, org_id, title) values ($1, $2, 'X')`, [user, org]),
    );

  it("can be made by someone who teaches there, or by no one's organization", async () => {
    await insert(teacher, orgId);
    await insert(principal, orgId);
    await insert(teacher, null);
  });

  it("cannot be pointed at a school the user does not belong to", async () => {
    await expect(insert(teacher, otherOrg)).rejects.toThrow(RLS);
    await expect(insert(outsider, orgId)).rejects.toThrow(RLS);
  });

  it("cannot be moved to another school afterwards", async () => {
    const id = (
      await db.query<{ id: string }>(
        `insert into lessons (owner_id, org_id, title) values ($1, $2, 'Y') returning id`,
        [teacher, orgId],
      )
    ).rows[0].id;
    await expect(
      asUser(db, teacher, (tx) =>
        tx.query(`update lessons set org_id = $2 where id = $1`, [id, otherOrg]),
      ),
    ).rejects.toThrow(RLS);
  });

  it("lose their school link, not themselves, if the school is removed", async () => {
    const doomed = (
      await db.query<{ id: string }>(
        `insert into organizations (name, slug) values ('Gone', 'gone') returning id`,
      )
    ).rows[0].id;
    const lesson = (
      await db.query<{ id: string }>(
        `insert into lessons (owner_id, org_id, title) values ($1, $2, 'Z') returning id`,
        [teacher, doomed],
      )
    ).rows[0].id;
    await db.query(`delete from organizations where id = $1`, [doomed]);
    const row = await db.query(`select org_id from lessons where id = $1`, [lesson]);
    expect(row.rows).toEqual([{ org_id: null }]);
  });
});
