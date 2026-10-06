-- Lessons, ingestion state, and the normalised graph tables (PRD section 7.4).
--
-- Every table is created with row-level security ENABLED and FORCED and with all grants
-- revoked, in this same file. With RLS on and no policy yet defined, a table is deny-all, so
-- there is no migration boundary at which any of these is readable. Policies are added in
-- 20261006000700_policies.sql once the private helpers they depend on exist; adding a policy
-- only ever grants access, so the ordering is safe in both directions.
--
-- FORCE is not redundant with ENABLE: without it, the table owner (`postgres` here) ignores
-- policies entirely. FORCE closes that hole. It does not stop a BYPASSRLS role, which is
-- precisely why the application never connects as `postgres`.

-- ---------------------------------------------------------------------------
-- Shared helper applied to every table below.
-- ---------------------------------------------------------------------------
create or replace function private.secure_table(p_table regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format('revoke all on %s from public, anon, authenticated', p_table);
end
$$;

-- ---------------------------------------------------------------------------
-- users_public
-- ---------------------------------------------------------------------------
create table if not exists public.users_public (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  is_creator   boolean not null default false,
  created_at   timestamptz not null default now()
);

comment on column public.users_public.is_creator is
  'Set through the creator attestation flow, never by a direct client update.';

select private.secure_table('public.users_public');

-- ---------------------------------------------------------------------------
-- lessons
-- ---------------------------------------------------------------------------
do $$ begin
  create type lesson_status as enum
    ('uploading', 'processing', 'needs_review', 'published', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type source_type as enum ('pdf', 'text', 'markdown', 'docx', 'audio');
exception when duplicate_object then null; end $$;

create table if not exists public.lessons (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  org_id        uuid,
  title         text not null default 'Untitled lesson',
  status        lesson_status not null default 'uploading',
  source_type   source_type,
  source_path   text,
  graph         jsonb,
  -- 0 until first publish. Learning Events record the version they were produced against so
  -- a republish never retroactively changes what an old event meant.
  graph_version integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint lessons_graph_version_non_negative check (graph_version >= 0),
  -- A published lesson must actually have a graph to render.
  constraint lessons_published_has_graph
    check (status <> 'published' or (graph is not null and graph_version > 0))
);

create index if not exists lessons_owner_idx on public.lessons (owner_id);
create index if not exists lessons_org_idx on public.lessons (org_id) where org_id is not null;
create index if not exists lessons_published_idx on public.lessons (status)
  where status = 'published';

select private.secure_table('public.lessons');

-- ---------------------------------------------------------------------------
-- ingestion_jobs
--
-- Columns beyond PRD 7.4: failed_stage, attempt, warnings, started_at, updated_at. A job must
-- be resumable from the stage that failed (PRD 5.1), which means recording which stage that
-- was rather than inferring it.
-- ---------------------------------------------------------------------------
do $$ begin
  create type ingestion_stage as enum (
    'pending', 'extract', 'chunk', 'concepts', 'merge', 'quiz',
    'validate', 'ground', 'signs', 'needs_review', 'failed'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.ingestion_jobs (
  id           uuid primary key default gen_random_uuid(),
  lesson_id    uuid not null references public.lessons (id) on delete cascade,
  stage        ingestion_stage not null default 'pending',
  failed_stage ingestion_stage,
  progress     real not null default 0,
  error        text,
  attempt      integer not null default 0,
  warnings     jsonb not null default '[]'::jsonb,
  tokens_in    bigint not null default 0,
  tokens_out   bigint not null default 0,
  cost_usd     numeric(12, 6) not null default 0,
  started_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint ingestion_jobs_progress_range check (progress >= 0 and progress <= 1),
  constraint ingestion_jobs_failed_has_stage
    check (stage <> 'failed' or failed_stage is not null)
);

-- One live job per lesson. This makes a double-clicked "Ingest" button safe at the database
-- rather than relying on application-level checking, which races by construction.
create unique index if not exists ingestion_jobs_one_active
  on public.ingestion_jobs (lesson_id)
  where stage not in ('needs_review', 'failed');

create index if not exists ingestion_jobs_lesson_idx on public.ingestion_jobs (lesson_id);

select private.secure_table('public.ingestion_jobs');

-- ---------------------------------------------------------------------------
-- ingestion_artifacts
--
-- Not in PRD 7.4; added so a failed job resumes without repeating completed LLM work
-- (PRD 5.1 "resumable from the failed step", 6.5 "idempotent and resumable per step").
--
-- Kept out of ingestion_jobs deliberately: that row is polled roughly once a second by
-- GET /api/lessons/{id}/status, and welding a megabyte of cold blob onto the hottest row in
-- the system would make every status poll pay for it.
--
-- Map-stage output is stored per chunk (shard_key = chunk id). That is what makes resume
-- real: when chunk 9 of 12 fails, resume re-runs chunk 9, not all twelve.
-- ---------------------------------------------------------------------------
do $$ begin
  create type artifact_kind as enum (
    'source_document', 'chunks', 'chunk_text', 'chunk_concepts', 'merged_graph',
    'quiz_graph', 'validated_graph', 'grounded_graph', 'graph_findings', 'sign_links'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.ingestion_artifacts (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.ingestion_jobs (id) on delete cascade,
  kind           artifact_kind not null,
  shard_key      text not null default '',
  schema_version integer not null default 1,
  -- Hash of the artifact this one was derived from. If an upstream stage is re-run with
  -- different output, downstream shards stop matching and correctly re-run.
  parent_sha256  text,
  content_sha256 text not null,
  size_bytes     integer not null,
  inline         jsonb,
  storage_path   text,
  created_at     timestamptz not null default now(),
  constraint artifact_inline_xor_storage
    check ((inline is null) <> (storage_path is null)),
  constraint artifact_size_non_negative check (size_bytes >= 0),
  constraint ingestion_artifacts_unique unique (job_id, kind, shard_key)
);

create index if not exists ingestion_artifacts_job_kind_idx
  on public.ingestion_artifacts (job_id, kind);

select private.secure_table('public.ingestion_artifacts');

-- ---------------------------------------------------------------------------
-- concepts
--
-- Normalised at publish for joins. `id` comes from the graph and is globally unique (a ULID),
-- so it is the primary key outright. That is what lets concept_mastery be unique on
-- (user_id, concept_id) exactly as PRD 7.4 specifies.
--
-- Republishing upserts these rows rather than replacing them, which is how stable ids survive
-- a new graph version and how learner mastery survives with them (PRD CE-2, P2-22).
-- ---------------------------------------------------------------------------
create table if not exists public.concepts (
  id            text primary key,
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  graph_version integer not null,
  order_index   integer not null,
  section_id    text,
  title         text not null,
  summary       text not null default '',
  key_term      text,
  -- Deleted concepts are retired, never removed: historical events still reference them.
  retired       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists concepts_lesson_idx
  on public.concepts (lesson_id, order_index) where not retired;
create index if not exists concepts_lesson_all_idx on public.concepts (lesson_id);

select private.secure_table('public.concepts');

-- ---------------------------------------------------------------------------
-- quiz_items
-- ---------------------------------------------------------------------------
do $$ begin
  create type quiz_item_type as enum ('mcq', 'true_false', 'short_answer');
exception when duplicate_object then null; end $$;

create table if not exists public.quiz_items (
  id         text primary key,
  lesson_id  uuid not null references public.lessons (id) on delete cascade,
  concept_id text not null references public.concepts (id) on delete cascade,
  type       quiz_item_type not null,
  retired    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quiz_items_concept_idx
  on public.quiz_items (concept_id) where not retired;
create index if not exists quiz_items_lesson_idx on public.quiz_items (lesson_id);

select private.secure_table('public.quiz_items');

-- ---------------------------------------------------------------------------
-- concept_variants
--
-- Cached alternative renderings of a concept's text. Permanently cached per
-- (concept_id, graph_version, reading_level) - PRD 6.2.
--
-- `status` and `generated_by` are additions to PRD 7.4, for claim-then-fill. Without them,
-- two simultaneous cache misses both call the LLM: the obvious
-- "INSERT ... ON CONFLICT DO NOTHING after generating" does not prevent the duplicate call,
-- it only discards one of the two results after paying for both.
-- ---------------------------------------------------------------------------
do $$ begin
  create type variant_status as enum ('pending', 'ready', 'failed');
exception when duplicate_object then null; end $$;

create table if not exists public.concept_variants (
  id            uuid primary key default gen_random_uuid(),
  concept_id    text not null references public.concepts (id) on delete cascade,
  graph_version integer not null,
  reading_level text not null,
  body          text,
  summary       text,
  status        variant_status not null default 'pending',
  generated_by  uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint concept_variants_reading_level
    check (reading_level in ('original', 'plain', 'simple')),
  constraint concept_variants_ready_has_body
    check (status <> 'ready' or body is not null),
  constraint concept_variants_key unique (concept_id, graph_version, reading_level)
);

select private.secure_table('public.concept_variants');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function private.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'lessons', 'ingestion_jobs', 'concepts', 'quiz_items', 'concept_variants'
  ] loop
    execute format(
      'create or replace trigger %I before update on public.%I
         for each row execute function private.touch_updated_at()',
      t || '_touch_updated_at', t
    );
  end loop;
end
$$;
