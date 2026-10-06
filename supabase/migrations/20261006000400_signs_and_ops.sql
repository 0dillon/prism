-- Sign clip library, plus the operational tables the backend needs.

-- ---------------------------------------------------------------------------
-- sign_clips
--
-- PRD 2.4 and the decision log: Prism shows clips of human signers for key terms. It does not
-- claim, and must not imply, full sign language translation. `source`, `license` and
-- `signer_credit` are not optional metadata - crediting signers and respecting clip licensing
-- is the condition on which this library can exist at all (PRD 9.3).
-- ---------------------------------------------------------------------------
create table if not exists public.sign_clips (
  id            uuid primary key default gen_random_uuid(),
  gloss         text not null,
  language      text not null default 'ase',
  storage_path  text not null,
  source        text not null,
  license       text not null,
  signer_credit text not null,
  created_at    timestamptz not null default now(),
  constraint sign_clips_gloss_per_language unique (gloss, language)
);

select private.secure_table('public.sign_clips');

-- ---------------------------------------------------------------------------
-- concept_sign_links
--
-- Every link starts unverified (PRD 5.1 step 8). Learners are shown verified links only, and
-- that filter lives in the policy rather than in a query, so a forgotten WHERE clause cannot
-- surface an unreviewed match (PRD P2-16).
-- ---------------------------------------------------------------------------
create table if not exists public.concept_sign_links (
  id            uuid primary key default gen_random_uuid(),
  concept_id    text not null references public.concepts (id) on delete cascade,
  sign_clip_id  uuid not null references public.sign_clips (id) on delete cascade,
  verified      boolean not null default false,
  verified_by   uuid references auth.users (id) on delete set null,
  verified_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint concept_sign_links_unique unique (concept_id, sign_clip_id),
  constraint concept_sign_links_verified_has_actor
    check (not verified or verified_by is not null)
);

create index if not exists concept_sign_links_concept_idx
  on public.concept_sign_links (concept_id) where verified;

select private.secure_table('public.concept_sign_links');

-- ---------------------------------------------------------------------------
-- llm_usage
--
-- One row per provider *attempt*, not per logical call: a failed attempt still costs money,
-- and a cost report that counts only successes understates the bill.
--
-- tokens_in is recorded as uncached + cache-write + cache-read. Counting only the uncached
-- remainder would make a well-cached ingestion job look far cheaper than it is, and PRD 6.2's
-- 0.50 USD per source target would appear to be met when it is not.
-- ---------------------------------------------------------------------------
create table if not exists public.llm_usage (
  id                    bigint generated always as identity primary key,
  occurred_at           timestamptz not null default now(),
  user_id               uuid references auth.users (id) on delete set null,
  org_id                uuid,
  lesson_id             uuid references public.lessons (id) on delete set null,
  job_id                uuid references public.ingestion_jobs (id) on delete set null,
  operation             text not null,
  tier                  text not null,
  provider              text not null,
  model                 text not null,
  attempt               integer not null default 1,
  outcome               text not null,
  input_tokens          integer not null default 0,
  output_tokens         integer not null default 0,
  cache_read_tokens     integer not null default 0,
  cache_creation_tokens integer not null default 0,
  latency_ms            integer not null default 0,
  cost_usd              numeric(12, 6) not null default 0,
  request_id            text,
  constraint llm_usage_tier check (tier in ('heavy', 'fast')),
  constraint llm_usage_outcome
    check (outcome in ('ok', 'invalid_output', 'refusal', 'timeout', 'rate_limited', 'error'))
);

create index if not exists llm_usage_job_idx on public.llm_usage (job_id)
  where job_id is not null;
create index if not exists llm_usage_occurred_idx on public.llm_usage (occurred_at desc);
create index if not exists llm_usage_operation_idx
  on public.llm_usage (operation, occurred_at desc);

select private.secure_table('public.llm_usage');

-- ---------------------------------------------------------------------------
-- idempotency_keys
--
-- Retry safety for expensive non-event operations (brief section 16). The unique constraint
-- is the mechanism: the first request inserts and proceeds, a retry collides and replays the
-- stored response instead of doing the work twice.
-- ---------------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null,
  idempotency_key text not null,
  request_hash    text not null,
  status_code     integer,
  response_body   jsonb,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint idempotency_keys_unique unique (user_id, endpoint, idempotency_key)
);

create index if not exists idempotency_keys_created_idx
  on public.idempotency_keys (created_at);

select private.secure_table('public.idempotency_keys');

-- ---------------------------------------------------------------------------
-- rate_limit_counters
--
-- A Postgres-backed fixed-window limiter. Chosen over Redis because the limit must hold
-- across every FastAPI replica (brief section 15 and 63: never rely on process memory for
-- correctness), and Postgres is already a hard dependency while Redis would be a new one for
-- this single purpose.
--
-- The whole mechanism is one atomic upsert, so concurrent requests serialise on the row
-- rather than all reading the same under-limit count and all proceeding.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_counters (
  bucket       text not null,
  window_start timestamptz not null,
  hits         integer not null default 0,
  primary key (bucket, window_start)
);

create index if not exists rate_limit_counters_window_idx
  on public.rate_limit_counters (window_start);

select private.secure_table('public.rate_limit_counters');

-- ---------------------------------------------------------------------------
-- audit_log
--
-- PRD 6.4 requires an audit log for admin actions and profile-sharing consent changes.
-- Append-only: no role may update or delete a row, enforced by a trigger below so that even
-- a future privileged bug cannot quietly rewrite history.
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references auth.users (id) on delete set null,
  action     text not null,
  target     text,
  metadata   jsonb not null default '{}'::jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_actor_idx on public.audit_log (actor_id, created_at desc);
create index if not exists audit_log_action_idx on public.audit_log (action, created_at desc);

select private.secure_table('public.audit_log');

create or replace function private.reject_audit_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = '42501';
end
$$;

create or replace trigger audit_log_is_append_only
  before update or delete on public.audit_log
  for each row execute function private.reject_audit_mutation();
