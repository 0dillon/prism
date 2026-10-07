-- Marketplace tables (PRD 5.9, 7.4): courses, course_lessons, creator_accounts,
-- purchases, with row-level security.
--
-- Published courses and their lesson lists are public. A purchase is readable by the
-- buyer and by the course's creator. Purchases and payout accounts are written server
-- side only (the payment webhook), so a client can never grant itself access.

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.users_public (id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  description text not null default '' check (char_length(description) <= 5000),
  cover_path text,
  cover_alt text check (cover_alt is null or char_length(cover_alt) <= 500),
  price_cents integer not null default 0 check (price_cents >= 0),
  currency text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  status text not null default 'draft' check (status in ('draft', 'published', 'suspended')),
  -- A cover image needs a text description before the course can be listed.
  check (status <> 'published' or cover_path is null or cover_alt is not null),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index courses_creator_idx on public.courses (creator_id);

create trigger courses_set_updated_at
  before update on public.courses
  for each row execute function public.set_updated_at();

create table public.course_lessons (
  course_id uuid not null references public.courses (id) on delete cascade,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  order_index integer not null check (order_index >= 0),
  is_preview boolean not null default false,
  primary key (course_id, lesson_id)
);

create index course_lessons_lesson_idx on public.course_lessons (lesson_id);

create table public.creator_accounts (
  user_id uuid primary key references public.users_public (id) on delete cascade,
  stripe_account_id text,
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.users_public (id) on delete restrict,
  course_id uuid not null references public.courses (id) on delete restrict,
  stripe_session_id text unique,
  amount_cents integer not null check (amount_cents >= 0),
  platform_fee_cents integer not null default 0 check (platform_fee_cents >= 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index purchases_buyer_idx on public.purchases (buyer_id, status);
create index purchases_course_idx on public.purchases (course_id);

create trigger purchases_set_updated_at
  before update on public.purchases
  for each row execute function public.set_updated_at();

alter table public.courses enable row level security;
alter table public.course_lessons enable row level security;
alter table public.creator_accounts enable row level security;
alter table public.purchases enable row level security;

create function public.owns_course(p_course uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.courses c where c.id = p_course and c.creator_id = auth.uid()
  )
$$;

revoke all on function public.owns_course(uuid) from public, anon;
grant execute on function public.owns_course(uuid) to authenticated, service_role;

-- courses: the catalog is public; creators manage their own.
grant select on public.courses to anon;
grant select, insert, update, delete on public.courses to authenticated;

create policy courses_select_published on public.courses
  for select to anon, authenticated
  using (status = 'published');

create policy courses_select_own on public.courses
  for select to authenticated
  using (creator_id = auth.uid());

create policy courses_insert_own on public.courses
  for insert to authenticated
  with check (creator_id = auth.uid());

create policy courses_update_own on public.courses
  for update to authenticated
  using (creator_id = auth.uid())
  with check (creator_id = auth.uid());

create policy courses_delete_own on public.courses
  for delete to authenticated
  using (creator_id = auth.uid() and status = 'draft');

-- course_lessons: visible with the course. A creator can add only lessons they own.
grant select on public.course_lessons to anon;
grant select, insert, update, delete on public.course_lessons to authenticated;

create policy course_lessons_select on public.course_lessons
  for select to anon, authenticated
  using (
    exists (select 1 from public.courses c where c.id = course_id and c.status = 'published')
    or public.owns_course(course_id)
  );

create policy course_lessons_insert_own on public.course_lessons
  for insert to authenticated
  with check (public.owns_course(course_id) and public.owns_lesson(lesson_id));

create policy course_lessons_update_own on public.course_lessons
  for update to authenticated
  using (public.owns_course(course_id))
  with check (public.owns_course(course_id) and public.owns_lesson(lesson_id));

create policy course_lessons_delete_own on public.course_lessons
  for delete to authenticated
  using (public.owns_course(course_id));

-- creator_accounts: a creator reads their own. The payment provider webhook writes it.
grant select on public.creator_accounts to authenticated;

create policy creator_accounts_select_own on public.creator_accounts
  for select to authenticated
  using (user_id = auth.uid());

-- purchases: the buyer and the course's creator read; only the server writes.
grant select on public.purchases to authenticated;

create policy purchases_select on public.purchases
  for select to authenticated
  using (buyer_id = auth.uid() or public.owns_course(course_id));
