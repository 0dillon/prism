-- Age, guardian consent, and data requests (PRD 6.4, P6-16).
--
-- A learner under 13 has an inactive account until a parent or guardian agrees, or the school
-- records that it holds that consent. Inactive means no access to lessons and no learning
-- events, because is_entitled is false for them. The date of birth is read from the sign-up
-- metadata by the same trigger that creates the account, so an under-13 account never exists
-- in an active state. Date of birth, guardian address and the consent token are never exposed
-- to a client.

create table public.user_consents (
  user_id uuid primary key references public.users_public (id) on delete cascade,
  birth_date date,
  status text not null default 'not_required'
    check (status in ('not_required', 'pending', 'granted')),
  guardian_email text check (guardian_email is null or guardian_email = lower(guardian_email)),
  token_hash bytea unique,
  token_expires_at timestamptz,
  requested_at timestamptz,
  granted_at timestamptz,
  granted_by text check (granted_by in ('guardian', 'school')),
  created_at timestamptz not null default now()
);

alter table public.user_consents enable row level security;

grant select (user_id, status, requested_at, granted_at, granted_by)
  on public.user_consents to authenticated;

create policy user_consents_select_own on public.user_consents
  for select to authenticated
  using (user_id = auth.uid());

create function public.consent_pending(p_user uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_consents c where c.user_id = p_user and c.status = 'pending'
  )
$$;

revoke all on function public.consent_pending(uuid) from public, anon;
grant execute on function public.consent_pending(uuid) to authenticated, service_role;

-- The sign-up trigger now also records the date of birth, and starts an under-13 account as
-- pending. A missing or unreadable date leaves the account unrestricted; the sign-up form asks
-- for it, so that only happens for accounts made some other way (the demo seed, an admin).
create or replace function public.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_birth date;
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

  begin
    v_birth := nullif(new.raw_user_meta_data ->> 'birth_date', '')::date;
  exception when others then
    v_birth := null;
  end;
  if v_birth is not null and v_birth <= current_date and v_birth > date '1900-01-01' then
    insert into public.user_consents (user_id, birth_date, status)
    values (
      new.id,
      v_birth,
      -- Compared as dates: interval comparison counts 30 days as a month and would be a day out.
      case when v_birth > (current_date - interval '13 years')::date then 'pending' else 'not_required' end
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

-- The child gives a parent or guardian's address. The token goes back to the server only, which
-- puts it in a link for the guardian; it is never shown to the child, who could otherwise agree
-- for themselves. A new request replaces the last one.
create function public.request_guardian_consent(p_guardian_email text) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_token text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  if not public.consent_pending(v_user) then
    raise exception 'this account does not need consent' using errcode = 'P0001';
  end if;
  update public.user_consents
  set guardian_email = lower(trim(p_guardian_email)),
      token_hash = sha256(convert_to(v_token, 'UTF8')),
      token_expires_at = now() + interval '14 days',
      requested_at = now()
  where user_id = v_user;
  return v_token;
end;
$$;

-- The guardian follows the link; they have no account, so this runs as the server only.
create function public.grant_guardian_consent(p_token text) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid;
  v_org uuid;
begin
  select c.user_id into v_user
  from public.user_consents c
  where c.token_hash = sha256(convert_to(coalesce(p_token, ''), 'UTF8'))
    and c.status = 'pending'
    and c.token_expires_at > now()
  for update;
  if v_user is null then
    raise exception 'this link is not valid any more' using errcode = 'P0002';
  end if;

  update public.user_consents
  set status = 'granted', granted_at = now(), granted_by = 'guardian',
      token_hash = null, token_expires_at = null
  where user_id = v_user;

  for v_org in select org_id from public.org_memberships where user_id = v_user loop
    insert into public.audit_log (org_id, actor_id, action, target, metadata)
    values (v_org, null, 'consent.granted', v_user::text, jsonb_build_object('by', 'guardian'));
  end loop;
  return v_user;
end;
$$;

-- A school that holds the guardian's agreement on file can record it for a student in one of
-- its classes. The teacher of the class or the school's principal may; the audit log names who.
create function public.record_school_consent(p_student uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  select c.org_id into v_org
  from public.enrollments e
  join public.classrooms c on c.id = e.classroom_id
  where e.student_id = p_student
    and (c.teacher_id = auth.uid() or public.org_role(c.org_id) = 'principal')
  limit 1;
  if v_org is null then
    raise exception 'only the teacher or principal of this student can record consent' using errcode = '42501';
  end if;
  if not public.consent_pending(p_student) then
    raise exception 'this account does not need consent' using errcode = 'P0001';
  end if;

  update public.user_consents
  set status = 'granted', granted_at = now(), granted_by = 'school',
      token_hash = null, token_expires_at = null
  where user_id = p_student;

  insert into public.audit_log (org_id, actor_id, action, target, metadata)
  values (v_org, auth.uid(), 'consent.recorded', p_student::text, jsonb_build_object('by', 'school'));
end;
$$;

-- Which students in a class are waiting for consent, for the teacher or principal.
create function public.pending_consents(p_classroom uuid) returns table (student_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select e.student_id
  from public.enrollments e
  where e.classroom_id = p_classroom
    and (public.is_classroom_teacher(p_classroom) or public.is_classroom_principal(p_classroom))
    and public.consent_pending(e.student_id)
$$;

revoke all on function public.request_guardian_consent(text) from public, anon;
revoke all on function public.grant_guardian_consent(text) from public, anon, authenticated;
revoke all on function public.record_school_consent(uuid) from public, anon;
revoke all on function public.pending_consents(uuid) from public, anon;
grant execute on function public.request_guardian_consent(text) to authenticated, service_role;
grant execute on function public.grant_guardian_consent(text) to service_role;
grant execute on function public.record_school_consent(uuid) to authenticated, service_role;
grant execute on function public.pending_consents(uuid) to authenticated, service_role;

-- An inactive account cannot read lessons or record learning events, and cannot join a class.
create or replace function public.is_entitled(p_user uuid, p_lesson uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (auth.uid() is null or auth.uid() = p_user)
    and not public.consent_pending(p_user)
    and exists (
      select 1 from public.lessons l
      where l.id = p_lesson
        and (
          l.owner_id = p_user
          or (
            l.status = 'published'
            and (
              exists (
                select 1
                from public.assignments a
                join public.enrollments e on e.classroom_id = a.classroom_id
                where a.lesson_id = l.id and e.student_id = p_user
              )
              or exists (
                select 1
                from public.course_lessons cl
                join public.purchases p on p.course_id = cl.course_id
                join public.courses c on c.id = cl.course_id
                where cl.lesson_id = l.id
                  and p.buyer_id = p_user
                  and p.status = 'paid'
                  and c.status <> 'suspended'
              )
              or exists (
                select 1
                from public.course_lessons cl
                join public.courses c on c.id = cl.course_id
                where cl.lesson_id = l.id and cl.is_preview and c.status = 'published'
              )
            )
          )
        )
    )
$$;

create or replace function public.join_classroom(p_code text) returns uuid
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
  if public.consent_pending(auth.uid()) then
    raise exception 'a parent or guardian needs to agree first' using errcode = 'P0004';
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

-- Requests to export or delete one's data. An export is produced straight away by the app and
-- recorded here; a deletion is recorded, then carried out by the operator.
create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users_public (id) on delete cascade,
  kind text not null check (kind in ('export', 'delete')),
  status text not null default 'requested' check (status in ('requested', 'completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- One open deletion request per person.
create unique index data_requests_one_open_delete
  on public.data_requests (user_id) where kind = 'delete' and status = 'requested';

alter table public.data_requests enable row level security;

grant select on public.data_requests to authenticated;
grant insert (user_id, kind) on public.data_requests to authenticated;

create policy data_requests_select_own on public.data_requests
  for select to authenticated
  using (user_id = auth.uid());

create policy data_requests_insert_own on public.data_requests
  for insert to authenticated
  with check (user_id = auth.uid());
