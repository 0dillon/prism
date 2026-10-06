-- Render profiles, learning events, mastery, and unmet needs (PRD sections 5.7 and 7.4).
--
-- As in the previous migration, every table is created with RLS enabled and forced and all
-- grants revoked, so none of them is readable before its policies land.

-- ---------------------------------------------------------------------------
-- render_profiles
--
-- PRD 6.4: profiles may reveal sensitive information, so they are private to the learner by
-- default and protected by row-level security. `share_with_teachers` defaults to false and
-- every change to it is audited (PRD B2B-5, P6-09).
-- ---------------------------------------------------------------------------
create table if not exists public.render_profiles (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  profile             jsonb not null,
  share_with_teachers boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.render_profiles is
  'Learner presentation preferences. Contains no diagnosis or disability field, by design '
  '(PRD 2.3 principle 2). Private by default.';

select private.secure_table('public.render_profiles');

-- ---------------------------------------------------------------------------
-- learning_events
--
-- Append-heavy and append-only. `id` is the client-generated ULID and the idempotency key:
-- delivery is at-least-once, so inserts use ON CONFLICT DO NOTHING and a replayed batch
-- creates nothing.
--
-- `received_at` is recorded alongside the client-supplied `occurred_at`. A learner's device
-- clock is not trustworthy, and for graded assessment the server's arrival order is the
-- defensible ordering. Keeping both means that choice stays open without a migration.
-- ---------------------------------------------------------------------------
do $$ begin
  create type learning_event_type as enum (
    'lesson_started', 'concept_viewed', 'concept_variant_requested',
    'quiz_presented', 'quiz_answered', 'question_asked',
    'session_paused', 'session_resumed', 'lesson_completed', 'profile_changed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type renderer_layout as enum ('reader', 'cards', 'conversation', 'visual');
exception when duplicate_object then null; end $$;

create table if not exists public.learning_events (
  id            text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  lesson_id     uuid not null references public.lessons (id) on delete cascade,
  graph_version integer not null,
  type          learning_event_type not null,
  concept_id    text,
  quiz_item_id  text,
  correct       boolean,
  duration_ms   integer,
  layout        renderer_layout not null,
  occurred_at   timestamptz not null,
  received_at   timestamptz not null default now(),
  constraint learning_events_duration_non_negative
    check (duration_ms is null or duration_ms >= 0),
  -- `correct` is meaningful only for an answer. Allowing it elsewhere would let a client
  -- manufacture mastery with, say, a concept_viewed event carrying correct = true.
  constraint learning_events_correct_only_on_answer
    check (correct is null or type = 'quiz_answered')
);

comment on column public.learning_events.layout is
  'Product analytics only. Never exposed in a teacher or principal view except through the '
  'suppressed aggregate in PRD B2B-4: the interface a learner chooses can reveal a disability.';

-- No foreign key on concept_id: concepts are retired rather than deleted, and this is the
-- hottest insert path in the product. The reference is validated by the API instead.

-- Drives the mastery recomputation: "the newest two quiz_answered rows for this learner and
-- concept". Ordered to match the query exactly so LIMIT 2 is a backward index scan with no
-- sort, INCLUDE (correct) makes it index-only, and the partial predicate keeps it small by
-- excluding concept_viewed, which dominates event volume.
create index if not exists learning_events_mastery_idx
  on public.learning_events (user_id, concept_id, occurred_at desc, id desc)
  include (correct)
  where type = 'quiz_answered' and correct is not null;

create index if not exists learning_events_viewed_idx
  on public.learning_events (user_id, concept_id)
  where type = 'concept_viewed';

create index if not exists learning_events_user_lesson_idx
  on public.learning_events (user_id, lesson_id, occurred_at desc);

-- Cheap for time-range dashboard queries over an append-only table.
create index if not exists learning_events_occurred_brin_idx
  on public.learning_events using brin (occurred_at);

select private.secure_table('public.learning_events');

-- ---------------------------------------------------------------------------
-- concept_mastery
--
-- Derived state, written only by the trigger in 20261006000800_mastery.sql.
--
-- `last_two_correct` is a cache of a computed boolean, NOT a running counter. PRD 7.4 names
-- the column but the counter reading of it is unsound: events arrive batched, at-least-once
-- and out of order, so [wrong@t3] followed by [correct@t1, correct@t2] would increment its
-- way to "mastered" when the true ordered history is in_progress. Recorded in PRD 9.1.
-- ---------------------------------------------------------------------------
do $$ begin
  create type mastery_status as enum ('not_started', 'in_progress', 'mastered');
exception when duplicate_object then null; end $$;

create table if not exists public.concept_mastery (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  concept_id       text not null,
  lesson_id        uuid not null references public.lessons (id) on delete cascade,
  status           mastery_status not null default 'not_started',
  attempts         integer not null default 0,
  correct_count    integer not null default 0,
  last_two_correct boolean not null default false,
  updated_at       timestamptz not null default now(),
  constraint concept_mastery_user_concept unique (user_id, concept_id)
);

create index if not exists concept_mastery_lesson_idx
  on public.concept_mastery (lesson_id, user_id, status);
create index if not exists concept_mastery_concept_idx
  on public.concept_mastery (concept_id, status);

select private.secure_table('public.concept_mastery');

-- ---------------------------------------------------------------------------
-- unmet_needs
--
-- Requests that no setting covers (PRD 5.4A step 5). Free learner text, so it may contain
-- personal information; it needs a retention policy before any school pilot (PRD 9.3).
-- ---------------------------------------------------------------------------
create table if not exists public.unmet_needs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users (id) on delete set null,
  request_text text not null,
  created_at   timestamptz not null default now(),
  constraint unmet_needs_text_bounded check (char_length(request_text) <= 2000)
);

create index if not exists unmet_needs_created_idx on public.unmet_needs (created_at desc);

select private.secure_table('public.unmet_needs');

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace trigger render_profiles_touch_updated_at
  before update on public.render_profiles
  for each row execute function private.touch_updated_at();
