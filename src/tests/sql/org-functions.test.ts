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

describe("invitations", () => {
  let org: string;
  let teacher: string;
  let teacherEmail: string;

  beforeAll(async () => {
    org = await createOrg(alice, "Invite School", "invite-school");
    teacher = await createUser(db, "invited_teacher");
    teacherEmail = "invited_teacher@example.test";
  });

  const invite = (user: string, email: string, role = "teacher") =>
    asUser(db, user, async (tx) => {
      const { rows } = await tx.query<{ invitation_id: string; token: string; expires_at: string }>(
        `select * from public.create_invitation($1, $2, $3)`,
        [org, email, role],
      );
      return rows[0];
    });

  const accept = (user: string, token: string) =>
    asUser(db, user, async (tx) => {
      const { rows } = await tx.query<{ joined_org: string; joined_role: string }>(
        `select * from public.accept_invitation($1)`,
        [token],
      );
      return rows[0];
    });

  it("lets a principal invite, and returns a token that is not stored in the clear", async () => {
    const made = await invite(alice, "  Invited_Teacher@Example.test ");
    expect(made.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await db.query<{ email: string; token_hash: Uint8Array }>(
      `select email, token_hash from org_invitations where id = $1`,
      [made.invitation_id],
    );
    expect(stored.rows[0].email).toBe(teacherEmail);
    expect(Buffer.from(stored.rows[0].token_hash).toString("hex")).not.toBe(made.token);
    const days = (new Date(made.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  it("gives an invited teacher a teacher membership when they accept", async () => {
    const made = await invite(alice, teacherEmail);
    expect(await accept(teacher, made.token)).toEqual({ joined_org: org, joined_role: "teacher" });
    const member = await db.query(
      `select role from org_memberships where org_id = $1 and user_id = $2`,
      [org, teacher],
    );
    expect(member.rows).toEqual([{ role: "teacher" }]);
    const log = await db.query(
      `select action from audit_log where org_id = $1 and action = 'invitation.accepted'`,
      [org],
    );
    expect(log.rows).toHaveLength(1);
  });

  it("can be accepted only once", async () => {
    const made = await invite(alice, teacherEmail);
    await accept(teacher, made.token);
    await expect(accept(teacher, made.token)).rejects.toThrow(/not valid any more/);
  });

  it("is not valid after seven days", async () => {
    const made = await invite(alice, teacherEmail);
    await db.query(
      `update org_invitations set expires_at = now() - interval '1 second' where id = $1`,
      [made.invitation_id],
    );
    await expect(accept(teacher, made.token)).rejects.toThrow(/not valid any more/);
  });

  it("refuses a token that does not exist", async () => {
    await expect(accept(teacher, "0".repeat(64))).rejects.toThrow(/not valid any more/);
  });

  it("can be accepted only by the person it was sent to", async () => {
    const made = await invite(alice, teacherEmail);
    await expect(accept(bob, made.token)).rejects.toThrow(/different email/);
    const unused = await db.query(`select accepted_at from org_invitations where id = $1`, [
      made.invitation_id,
    ]);
    expect(unused.rows[0]).toEqual({ accepted_at: null });
  });

  it("does not demote a principal who accepts a teacher invitation", async () => {
    const made = await invite(alice, "alice@example.test");
    expect((await accept(alice, made.token)).joined_role).toBe("teacher");
    const member = await db.query(
      `select role from org_memberships where org_id = $1 and user_id = $2`,
      [org, alice],
    );
    expect(member.rows).toEqual([{ role: "principal" }]);
  });

  it("is limited to principals of that organization", async () => {
    await expect(invite(teacher, "x@example.test")).rejects.toThrow(/only a principal/);
    await expect(invite(bob, "x@example.test")).rejects.toThrow(/only a principal/);
  });

  it("refuses a role other than teacher or principal", async () => {
    await expect(invite(alice, "x@example.test", "student")).rejects.toThrow(/check/);
  });

  it("shows the principal their invitations, without the token hash", async () => {
    const rows = await asUser(db, alice, (tx) => tx.query(`select id, email from org_invitations`));
    expect(rows.rows.length).toBeGreaterThan(0);
    await expect(
      asUser(db, alice, (tx) => tx.query(`select token_hash from org_invitations`)),
    ).rejects.toThrow(/permission denied/);
    const other = await asUser(db, bob, (tx) => tx.query(`select id from org_invitations`));
    expect(other.rows).toHaveLength(0);
  });
});
