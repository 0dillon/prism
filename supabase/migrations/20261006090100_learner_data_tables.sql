-- Learner data tables (PRD 7.4): render_profiles, learning_events, concept_mastery,
-- unmet_needs. Row-level security is on and API privileges are revoked until the
-- row-level security migration grants access.
--
-- There is deliberately no diagnosis or disability column anywhere (PRD 6.4).

-- A learner's Render Profile. Private by default; share_with_teachers is the opt-in.
create table public.render_profiles (
  user_id uuid primary key references public.users_public (id) on delete cascade,
  profile jsonb not null,
  share_with_teachers boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger render_profiles_set_updated_at
  before update on public.render_profiles
  for each row execute function public.set_updated_at();

-- The event log. The id is a client-generated ULID so retries are idempotent.
create table public.learning_events (
  id text primary key,
  user_id uuid not null references public.users_public (id) on delete cascade,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  graph_version integer not null check (graph_version >= 0),
  type text not null check (type in (
    'lesson_started', 'concept_viewed', 'concept_variant_requested',
    'quiz_presented', 'quiz_answered', 'question_asked',
    'session_paused', 'session_resumed', 'lesson_completed', 'profile_changed'
  )),
  concept_id text,
  quiz_item_id text,
  correct boolean,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  layout text not null check (layout in ('reader', 'cards', 'conversation', 'visual')),
  occurred_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index learning_events_user_lesson_idx on public.learning_events (user_id, lesson_id);
create index learning_events_lesson_concept_idx on public.learning_events (lesson_id, concept_id);
create index learning_events_answers_idx
  on public.learning_events (user_id, lesson_id, concept_id, occurred_at desc)
  where type = 'quiz_answered';

-- Derived mastery, one row per learner and concept, maintained by trigger.
-- last_two_correct is true when the two most recent answers were both correct.
create table public.concept_mastery (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users_public (id) on delete cascade,
  lesson_id uuid not null,
  concept_id text not null,
  status text not null default 'in_progress'
    check (status in ('not_started', 'in_progress', 'mastered')),
  attempts integer not null default 0 check (attempts >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  last_two_correct boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, lesson_id, concept_id),
  foreign key (lesson_id, concept_id) references public.concepts (lesson_id, id) on delete cascade
);

create index concept_mastery_lesson_idx on public.concept_mastery (lesson_id, status);

-- Requests that no Render Profile setting covers, logged to guide the roadmap.
create table public.unmet_needs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users_public (id) on delete set null,
  request_text text not null check (char_length(request_text) between 1 and 2000),
  created_at timestamptz not null default now()
);

alter table public.render_profiles enable row level security;
alter table public.learning_events enable row level security;
alter table public.concept_mastery enable row level security;
alter table public.unmet_needs enable row level security;

revoke all on public.render_profiles, public.learning_events, public.concept_mastery,
  public.unmet_needs from anon, authenticated;
