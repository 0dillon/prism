import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createDb, createUser, type Db } from "./harness";

let db: Db;
let alice: string;
let bob: string;

beforeAll(async () => {
  db = await createDb();
  alice = await createUser(db, "alice");
  bob = await createUser(db, "bob");
});

afterAll(async () => {
  await db.close();
});

const createOrg = (user: string, name: string, slug: string) =>
  asUser(db, user, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `select public.create_organization($1, $2) as id`,
      [name, slug],
    );
    return rows[0].id;
  });

describe("create_organization", () => {
  it("makes the caller the principal and records it in the audit log", async () => {
    const id = await createOrg(alice, "  Oak School ", "oak-school");
    const org = await db.query<{ name: string; created_by: string }>(
      `select name, created_by from organizations where id = $1`,
      [id],
    );
    expect(org.rows[0]).toEqual({ name: "Oak School", created_by: alice });
    const member = await db.query(
      `select role from org_memberships where org_id = $1 and user_id = $2`,
      [id, alice],
    );
    expect(member.rows).toEqual([{ role: "principal" }]);
    const log = await db.query(`select action, actor_id from audit_log where org_id = $1`, [id]);
    expect(log.rows).toEqual([{ action: "org.created", actor_id: alice }]);
  });

  it("lets the creator read the organization straight away", async () => {
    const id = await createOrg(bob, "Elm", "elm");
    const seen = await asUser(db, bob, (tx) =>
      tx.query(`select id from organizations where id = $1`, [id]),
    );
    expect(seen.rows).toHaveLength(1);
    const other = await asUser(db, alice, (tx) =>
      tx.query(`select id from organizations where id = $1`, [id]),
    );
    expect(other.rows).toHaveLength(0);
  });

  it("refuses a taken slug without leaving anything behind", async () => {
    await expect(createOrg(bob, "Another", "oak-school")).rejects.toThrow(/duplicate key/);
    const orphans = await db.query(`select 1 from organizations where name = 'Another'`);
    expect(orphans.rows).toHaveLength(0);
  });

  it("refuses a malformed slug", async () => {
    await expect(createOrg(bob, "Bad", "Not A Slug")).rejects.toThrow(/check/);
  });

  it("is closed to people who are not signed in", async () => {
    await expect(
      asAnon(db, (tx) => tx.query(`select public.create_organization('X', 'x')`)),
    ).rejects.toThrow(/permission denied/);
  });
});
