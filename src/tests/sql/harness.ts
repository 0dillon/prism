import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * In-process Postgres for migration, RLS, and trigger tests.
 *
 * There is no Docker on every dev machine, so `supabase db reset` is not always
 * available. PGlite is real Postgres compiled to WASM. The shim below recreates the
 * parts of a Supabase project that migrations depend on: the three API roles, the
 * auth and storage schemas, auth.uid(), and the no-default-privileges setup of a project with automatic table exposure off.
 * Migrations are then applied in filename order, exactly as `supabase db reset` would.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const SUPABASE_SHIM = `
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;

create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$$;

grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;

-- Match a project with "Automatically expose new tables" off, the recommended
-- setting: new public tables get no default privileges for the API roles, so every
-- migration must grant access explicitly. Only functions keep the default execute grant.
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export type Db = PGlite;
export type Tx = Transaction;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/** Creates a fresh database with the Supabase shim and every migration applied. */
export async function createDb(options: { upTo?: string } = {}): Promise<Db> {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  for (const file of migrationFiles()) {
    if (options.upTo && file > options.upTo) break;
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

/** Inserts an auth user (the signup trigger creates users_public) and returns its id. */
export async function createUser(db: Db, name: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
    [`${name}@example.test`, JSON.stringify({ display_name: name })],
  );
  return result.rows[0].id;
}

/** Runs `fn` as an authenticated API user, so row-level security applies. */
export async function asUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await tx.exec(`set local role authenticated`);
    return fn(tx);
  });
}

/** Runs `fn` as an unauthenticated API caller. */
export async function asAnon<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role anon`);
    return fn(tx);
  });
}

/** Runs `fn` as the service role, which bypasses row-level security. */
export async function asService<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role service_role`);
    return fn(tx);
  });
}

/**
 * Gives learners access to a published lesson the way a school does: a classroom owned by
 * the lesson's owner, the learners enrolled in it, and the lesson assigned to it.
 */
export async function assignLesson(
  db: Db,
  ownerId: string,
  lessonId: string,
  learnerIds: string[],
): Promise<void> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const code = Array.from(
    { length: 6 },
    () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)],
  ).join("");
  const org = (
    await db.query<{ id: string }>(
      `insert into organizations (name, slug) values ('School', $1) returning id`,
      [`school-${suffix}`],
    )
  ).rows[0].id;
  await db.query(`insert into org_memberships (org_id, user_id, role) values ($1, $2, 'teacher')`, [
    org,
    ownerId,
  ]);
  const room = (
    await db.query<{ id: string }>(
      `insert into classrooms (org_id, teacher_id, name, join_code) values ($1, $2, 'Class', $3) returning id`,
      [org, ownerId, code],
    )
  ).rows[0].id;
  await db.query(`insert into assignments (classroom_id, lesson_id) values ($1, $2)`, [
    room,
    lessonId,
  ]);
  for (const learner of learnerIds) {
    await db.query(`insert into enrollments (classroom_id, student_id) values ($1, $2)`, [
      room,
      learner,
    ]);
  }
}
