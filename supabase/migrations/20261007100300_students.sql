-- Adding students to a classroom (PRD 5.8, P6-04): by email list, by CSV, or by join code.
-- All three end as rows in enrollments. An email with no account yet is kept as a pending
-- enrollment and applied when that address signs up with a confirmed email, so a teacher
-- can add a whole roster before the students have accounts. The result of an add reports
-- only "added" or "already", so it does not reveal which addresses have accounts.

create table public.pending_enrollments (
  classroom_id uuid not null references public.classrooms (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) between 3 and 320),
  created_at timestamptz not null default now(),
  primary key (classroom_id, email)
);

create index pending_enrollments_email_idx on public.pending_enrollments (email);

alter table public.pending_enrollments enable row level security;

grant select on public.pending_enrollments to authenticated;

create policy pending_enrollments_select on public.pending_enrollments
  for select to authenticated
  using (public.is_classroom_teacher(classroom_id) or public.is_classroom_principal(classroom_id));

-- Enrolling also makes the student a member of the school, unless they already hold a role there.
create function public.enroll_student(p_classroom uuid, p_student uuid) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_rows integer;
begin
  select org_id into v_org from public.classrooms where id = p_classroom;
  insert into public.enrollments (classroom_id, student_id)
  values (p_classroom, p_student)
  on conflict do nothing;
  get diagnostics v_rows = row_count;
  insert into public.org_memberships (org_id, user_id, role)
  values (v_org, p_student, 'student')
  on conflict (org_id, user_id) do nothing;
  return v_rows > 0;
end;
$$;

-- Internal: only the other functions and triggers in this file call it.
revoke all on function public.enroll_student(uuid, uuid) from public, anon, authenticated;

create function public.add_students_by_email(p_classroom uuid, p_emails text[])
returns table (student_email text, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_user uuid;
  v_added boolean;
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  if not public.is_classroom_teacher(p_classroom) then
    raise exception 'only the classroom teacher can add students' using errcode = '42501';
  end if;
  if exists (select 1 from public.classrooms c where c.id = p_classroom and c.archived_at is not null) then
    raise exception 'this class is archived' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_emails, 1), 0) > 500 then
    raise exception 'too many students at once' using errcode = '54000';
  end if;

  for v_email in
    select distinct lower(trim(e)) as addr from unnest(p_emails) as e where trim(e) <> ''
    order by addr
  loop
    select u.id into v_user from auth.users u where lower(u.email) = v_email limit 1;
    if v_user is not null then
      v_added := public.enroll_student(p_classroom, v_user);
    else
      insert into public.pending_enrollments (classroom_id, email)
      values (p_classroom, v_email)
      on conflict do nothing;
      get diagnostics v_rows = row_count;
      v_added := v_rows > 0;
    end if;
    student_email := v_email;
    outcome := case when v_added then 'added' else 'already' end;
    return next;
  end loop;

  insert into public.audit_log (org_id, actor_id, action, target, metadata)
  select c.org_id, auth.uid(), 'classroom.students_added', p_classroom::text,
         jsonb_build_object('count', coalesce(array_length(p_emails, 1), 0))
  from public.classrooms c where c.id = p_classroom;
end;
$$;

-- A student joins with the class code. The code is the only thing they need to know.
create function public.join_classroom(p_code text) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  select c.id into v_room
  from public.classrooms c
  where c.join_code = upper(trim(coalesce(p_code, ''))) and c.archived_at is null;
  if v_room is null then
    raise exception 'that class code was not found' using errcode = 'P0002';
  end if;
  perform public.enroll_student(v_room, auth.uid());
  return v_room;
end;
$$;

-- Applies waiting enrollments when an address becomes a confirmed account.
create function public.apply_pending_enrollments() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room uuid;
begin
  if new.email is null or new.email_confirmed_at is null then
    return new;
  end if;
  for v_room in
    select classroom_id from public.pending_enrollments where email = lower(new.email)
  loop
    perform public.enroll_student(v_room, new.id);
  end loop;
  delete from public.pending_enrollments where email = lower(new.email);
  return new;
end;
$$;

-- Named to sort after on_auth_user_created, so users_public exists when it runs.
create trigger on_auth_user_enroll_pending
  after insert on auth.users
  for each row execute function public.apply_pending_enrollments();

create trigger on_auth_user_confirmed_enroll_pending
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.apply_pending_enrollments();

revoke all on function public.apply_pending_enrollments() from public, anon, authenticated;
revoke all on function public.add_students_by_email(uuid, text[]) from public, anon;
revoke all on function public.join_classroom(text) from public, anon;
grant execute on function public.add_students_by_email(uuid, text[]) to authenticated, service_role;
grant execute on function public.join_classroom(text) to authenticated, service_role;
