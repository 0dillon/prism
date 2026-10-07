-- School tables (PRD 5.8, 7.4): organizations, org_memberships, classrooms,
-- enrollments, assignments, audit_log, with row-level security.
--
-- Access rules, from the PRD access table:
--   * a teacher reads and manages only their own classrooms;
--   * a principal reads every classroom in their organization;
--   * a student reads the classrooms they are enrolled in and what is assigned to them;
--   * organizations, memberships and the audit log are created server side (service role).
-- Nothing here exposes a learner's Render Profile; that stays behind its own opt-in.

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  monthly_spend_cap_usd numeric(10, 2) check (monthly_spend_cap_usd is null or monthly_spend_cap_usd >= 0),
  created_by uuid references public.users_public (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.org_memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.users_public (id) on delete cascade,
  role text not null check (role in ('principal', 'teacher', 'student')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create index org_memberships_user_idx on public.org_memberships (user_id);

create table public.classrooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  teacher_id uuid not null references public.users_public (id) on delete restrict,
  name text not null check (char_length(name) between 1 and 200),
  grade text check (grade is null or char_length(grade) <= 40),
  subject text check (subject is null or char_length(subject) <= 80),
  join_code text not null unique check (join_code ~ '^[A-Z2-9]{6}$'),
  created_at timestamptz not null default now()
);

create index classrooms_org_idx on public.classrooms (org_id);
create index classrooms_teacher_idx on public.classrooms (teacher_id);

create table public.enrollments (
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  student_id uuid not null references public.users_public (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (classroom_id, student_id)
);

create index enrollments_student_idx on public.enrollments (student_id);

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  unique (classroom_id, lesson_id)
);

create index assignments_lesson_idx on public.assignments (lesson_id);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations (id) on delete cascade,
  actor_id uuid references public.users_public (id) on delete set null,
  action text not null check (char_length(action) between 1 and 100),
  target text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_org_idx on public.audit_log (org_id, created_at desc);

alter table public.organizations enable row level security;
alter table public.org_memberships enable row level security;
alter table public.classrooms enable row level security;
alter table public.enrollments enable row level security;
alter table public.assignments enable row level security;
alter table public.audit_log enable row level security;

-- Policy helpers. Security definer so a policy on one table can read another without
-- recursing into that table's own policies.

create function public.org_role(p_org uuid) returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role from public.org_memberships m where m.org_id = p_org and m.user_id = auth.uid()
$$;

create function public.is_classroom_teacher(p_classroom uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.classrooms c where c.id = p_classroom and c.teacher_id = auth.uid()
  )
$$;

create function public.is_classroom_principal(p_classroom uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.classrooms c
    join public.org_memberships m on m.org_id = c.org_id
    where c.id = p_classroom and m.user_id = auth.uid() and m.role = 'principal'
  )
$$;

create function public.is_enrolled(p_classroom uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.enrollments e
    where e.classroom_id = p_classroom and e.student_id = auth.uid()
  )
$$;

revoke all on function public.org_role(uuid) from public, anon;
revoke all on function public.is_classroom_teacher(uuid) from public, anon;
revoke all on function public.is_classroom_principal(uuid) from public, anon;
revoke all on function public.is_enrolled(uuid) from public, anon;
grant execute on function public.org_role(uuid) to authenticated, service_role;
grant execute on function public.is_classroom_teacher(uuid) to authenticated, service_role;
grant execute on function public.is_classroom_principal(uuid) to authenticated, service_role;
grant execute on function public.is_enrolled(uuid) to authenticated, service_role;

-- organizations: members read; the principal edits the name and spend cap. Creation
-- happens server side so the creator is made principal in the same step.
grant select, update on public.organizations to authenticated;

create policy organizations_select_member on public.organizations
  for select to authenticated
  using (public.org_role(id) is not null);

create policy organizations_update_principal on public.organizations
  for update to authenticated
  using (public.org_role(id) = 'principal')
  with check (public.org_role(id) = 'principal');

-- org_memberships: a user sees their own; a principal sees the whole organization.
-- Changes are server side (invitations, roster import).
grant select on public.org_memberships to authenticated;

create policy org_memberships_select on public.org_memberships
  for select to authenticated
  using (user_id = auth.uid() or public.org_role(org_id) = 'principal');

-- classrooms: the teacher manages their own; the principal reads the organization's;
-- enrolled students read the ones they are in.
grant select, insert, update, delete on public.classrooms to authenticated;

create policy classrooms_select on public.classrooms
  for select to authenticated
  using (
    teacher_id = auth.uid()
    or public.org_role(org_id) = 'principal'
    or public.is_enrolled(id)
  );

create policy classrooms_insert_teacher on public.classrooms
  for insert to authenticated
  with check (teacher_id = auth.uid() and public.org_role(org_id) in ('teacher', 'principal'));

create policy classrooms_update_teacher on public.classrooms
  for update to authenticated
  using (teacher_id = auth.uid())
  with check (teacher_id = auth.uid() and public.org_role(org_id) in ('teacher', 'principal'));

create policy classrooms_delete_teacher on public.classrooms
  for delete to authenticated
  using (teacher_id = auth.uid());

-- enrollments: the student sees their own; the classroom's teacher and the principal
-- see the roster. The teacher adds and removes students.
grant select, insert, delete on public.enrollments to authenticated;

create policy enrollments_select on public.enrollments
  for select to authenticated
  using (
    student_id = auth.uid()
    or public.is_classroom_teacher(classroom_id)
    or public.is_classroom_principal(classroom_id)
  );

create policy enrollments_insert_teacher on public.enrollments
  for insert to authenticated
  with check (public.is_classroom_teacher(classroom_id));

create policy enrollments_delete_teacher on public.enrollments
  for delete to authenticated
  using (public.is_classroom_teacher(classroom_id));

-- assignments: readable by the teacher, the principal and enrolled students. Only the
-- classroom's teacher assigns, and only lessons they own.
grant select, insert, update, delete on public.assignments to authenticated;

create policy assignments_select on public.assignments
  for select to authenticated
  using (
    public.is_classroom_teacher(classroom_id)
    or public.is_classroom_principal(classroom_id)
    or public.is_enrolled(classroom_id)
  );

create policy assignments_insert_teacher on public.assignments
  for insert to authenticated
  with check (public.is_classroom_teacher(classroom_id) and public.owns_lesson(lesson_id));

create policy assignments_update_teacher on public.assignments
  for update to authenticated
  using (public.is_classroom_teacher(classroom_id))
  with check (public.is_classroom_teacher(classroom_id) and public.owns_lesson(lesson_id));

create policy assignments_delete_teacher on public.assignments
  for delete to authenticated
  using (public.is_classroom_teacher(classroom_id));

-- audit_log: the principal reads their organization's log. Entries are written
-- server side only, so no one can edit history.
grant select on public.audit_log to authenticated;

create policy audit_log_select_principal on public.audit_log
  for select to authenticated
  using (org_id is not null and public.org_role(org_id) = 'principal');
