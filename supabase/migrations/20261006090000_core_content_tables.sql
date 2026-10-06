-- Core content tables (PRD 7.4): users_public, lessons, ingestion_jobs, concepts,
-- quiz_items, concept_variants.
--
-- Row-level security is enabled on every table here and the API roles are stripped of
-- privileges, so nothing is reachable until the policies and grants in the row-level
-- security migration are applied.

create function public.set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Public user profile. One row per auth user, created by trigger on signup.
create table public.users_public (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  is_creator boolean not null default false,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users_public (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      split_part(coalesce(new.email, ''), '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- A lesson and its Knowledge Graph. org_id gains its foreign key when organizations exist.
create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.users_public (id) on delete cascade,
  org_id uuid,
  title text not null default '',
  status text not null default 'uploading'
    check (status in ('uploading', 'processing', 'needs_review', 'published', 'failed')),
  source_type text check (source_type in ('pdf', 'txt', 'md', 'docx', 'audio')),
  source_path text,
  graph jsonb,
  graph_version integer not null default 0 check (graph_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lessons_owner_id_idx on public.lessons (owner_id);
create index lessons_org_id_idx on public.lessons (org_id) where org_id is not null;
create index lessons_status_idx on public.lessons (status);

create trigger lessons_set_updated_at
  before update on public.lessons
  for each row execute function public.set_updated_at();

-- Pipeline state. artifacts holds each step's output so a failed job can resume.
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  stage text not null default 'uploading',
  progress integer not null default 0 check (progress between 0 and 100),
  error text,
  artifacts jsonb not null default '{}'::jsonb,
  tokens_in bigint not null default 0 check (tokens_in >= 0),
  tokens_out bigint not null default 0 check (tokens_out >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ingestion_jobs_lesson_id_idx on public.ingestion_jobs (lesson_id);

create trigger ingestion_jobs_set_updated_at
  before update on public.ingestion_jobs
  for each row execute function public.set_updated_at();

-- Normalized concepts for joins. Ids come from the graph and are stable across
-- versions, so a row is updated in place on re-publish and flagged retired if removed.
create table public.concepts (
  id text not null,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  graph_version integer not null check (graph_version >= 1),
  order_index integer not null,
  title text not null,
  summary text not null,
  key_term text,
  retired boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (lesson_id, id)
);

create index concepts_lesson_order_idx on public.concepts (lesson_id, order_index);

create table public.quiz_items (
  id text not null,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  concept_id text not null,
  type text not null check (type in ('mcq', 'true_false', 'short_answer')),
  retired boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (lesson_id, id),
  foreign key (lesson_id, concept_id) references public.concepts (lesson_id, id) on delete cascade
);

create index quiz_items_concept_idx on public.quiz_items (lesson_id, concept_id);

-- Cached alternative renderings of a concept, generated once per level.
create table public.concept_variants (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  concept_id text not null,
  graph_version integer not null check (graph_version >= 1),
  reading_level text not null check (reading_level in ('plain', 'simple')),
  body text not null,
  summary text not null,
  created_at timestamptz not null default now(),
  unique (lesson_id, concept_id, graph_version, reading_level),
  foreign key (lesson_id, concept_id) references public.concepts (lesson_id, id) on delete cascade
);

alter table public.users_public enable row level security;
alter table public.lessons enable row level security;
alter table public.ingestion_jobs enable row level security;
alter table public.concepts enable row level security;
alter table public.quiz_items enable row level security;
alter table public.concept_variants enable row level security;

revoke all on public.users_public, public.lessons, public.ingestion_jobs, public.concepts,
  public.quiz_items, public.concept_variants from anon, authenticated;
