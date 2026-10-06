-- Sign clip library (PRD 5.6.4, 7.4): sign_clips, concept_sign_links, and the
-- private sign-clips storage bucket.
--
-- Clips are short videos of human signers for key terms. Prism never generates signs.
-- Every link starts unverified and learners only ever see verified links.

create table public.sign_clips (
  id uuid primary key default gen_random_uuid(),
  gloss text not null check (char_length(gloss) between 1 and 80),
  language text not null default 'ase' check (language in ('ase')),
  storage_path text not null,
  source text not null,
  license text not null,
  signer_credit text,
  created_at timestamptz not null default now(),
  unique (gloss, language)
);

create table public.concept_sign_links (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null,
  concept_id text not null,
  sign_clip_id uuid not null references public.sign_clips (id) on delete cascade,
  verified boolean not null default false,
  verified_by uuid references public.users_public (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (lesson_id, concept_id),
  foreign key (lesson_id, concept_id) references public.concepts (lesson_id, id) on delete cascade,
  -- A verified link must record who verified it.
  check (not verified or verified_by is not null)
);

create index concept_sign_links_clip_idx on public.concept_sign_links (sign_clip_id);

alter table public.sign_clips enable row level security;
alter table public.concept_sign_links enable row level security;

revoke all on public.sign_clips, public.concept_sign_links from anon, authenticated;

-- Private bucket. Clips are served to learners through short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('sign-clips', 'sign-clips', false)
on conflict (id) do nothing;
