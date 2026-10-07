-- Classrooms (PRD 5.8, P6-03): archiving and server-made join codes.
--
-- A classroom is archived, not deleted, so its students' records and the lessons it was
-- given are kept. Archived classrooms drop out of the principal's summary and layout
-- counts. Join codes are made by the database so a client cannot choose one, and the
-- columns a teacher may edit are limited to the descriptive ones.

alter table public.classrooms add column archived_at timestamptz;

revoke insert, update, delete on public.classrooms from authenticated;
grant update (name, grade, subject, archived_at) on public.classrooms to authenticated;

-- Six characters from an alphabet without 0, 1, I or O, so a code read aloud or copied by
-- hand is hard to get wrong.
create function public.new_join_code() returns text
language plpgsql
volatile
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.classrooms c where c.join_code = v_code);
  end loop;
  return v_code;
end;
$$;

create function public.create_classroom(
  p_org uuid,
  p_name text,
  p_grade text default null,
  p_subject text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid;
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;
  if coalesce(public.org_role(p_org), '') not in ('teacher', 'principal') then
    raise exception 'only teachers can create classrooms' using errcode = '42501';
  end if;

  insert into public.classrooms (org_id, teacher_id, name, grade, subject, join_code)
  values (p_org, v_user, trim(p_name), nullif(trim(p_grade), ''), nullif(trim(p_subject), ''),
          public.new_join_code())
  returning id into v_id;
  return v_id;
end;
$$;

-- A teacher can replace a code that has been shared too widely.
create function public.regenerate_join_code(p_classroom uuid) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not public.is_classroom_teacher(p_classroom) then
    raise exception 'only the classroom teacher can change the join code' using errcode = '42501';
  end if;
  v_code := public.new_join_code();
  update public.classrooms set join_code = v_code where id = p_classroom;
  return v_code;
end;
$$;

revoke all on function public.new_join_code() from public, anon, authenticated;
revoke all on function public.create_classroom(uuid, text, text, text) from public, anon;
revoke all on function public.regenerate_join_code(uuid) from public, anon;
grant execute on function public.create_classroom(uuid, text, text, text) to authenticated, service_role;
grant execute on function public.regenerate_join_code(uuid) to authenticated, service_role;

-- Archived classrooms are left out of the organization-wide views.
create or replace view public.v_org_classroom_summary as
with pairs as (
  select
    c.id as classroom_id,
    e.student_id,
    a.lesson_id,
    (select count(*) from public.concepts k
      where k.lesson_id = a.lesson_id and not k.retired) as total,
    (select count(*) from public.concept_mastery m
      join public.concepts k on k.lesson_id = m.lesson_id and k.id = m.concept_id and not k.retired
      where m.user_id = e.student_id and m.lesson_id = a.lesson_id and m.status = 'mastered')
      as mastered
  from public.classrooms c
  join public.enrollments e on e.classroom_id = c.id
  join public.assignments a on a.classroom_id = c.id
  where c.archived_at is null
)
select
  c.org_id,
  c.id as classroom_id,
  c.name as classroom_name,
  c.teacher_id,
  (select count(*) from public.enrollments e where e.classroom_id = c.id)::int as students,
  (select count(*) from public.assignments a where a.classroom_id = c.id)::int as assigned_lessons,
  (select count(distinct e.student_id)
    from public.enrollments e
    join public.learning_events ev on ev.user_id = e.student_id
    join public.assignments a on a.classroom_id = c.id and a.lesson_id = ev.lesson_id
    where e.classroom_id = c.id and ev.occurred_at > now() - interval '7 days')::int
    as active_learners,
  coalesce(round(avg(case when p.total > 0 and p.mastered >= p.total then 1 else 0 end), 3), 0)
    as completion,
  coalesce(round(avg(case when p.total > 0 then least(p.mastered::numeric / p.total, 1) else 0 end), 3), 0)
    as average_mastery
from public.classrooms c
left join pairs p on p.classroom_id = c.id
where public.org_role(c.org_id) = 'principal' and c.archived_at is null
group by c.org_id, c.id, c.name, c.teacher_id;

create or replace view public.v_org_layout_usage as
with usage as (
  select c.org_id, ev.layout, count(distinct ev.user_id) as learners
  from public.classrooms c
  join public.enrollments e on e.classroom_id = c.id
  join public.learning_events ev on ev.user_id = e.student_id
  where public.org_role(c.org_id) = 'principal' and c.archived_at is null
  group by c.org_id, ev.layout
),
shown as (
  select * from usage where learners >= 5
)
select
  s.org_id,
  s.layout,
  s.learners::int as learners,
  round(s.learners::numeric / sum(s.learners) over (partition by s.org_id), 3) as share
from shown s;
