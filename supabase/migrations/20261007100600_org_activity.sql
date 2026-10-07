-- Activity for the principal's dashboard (PRD 5.8, P6-10 to P6-12). The summary view gives the
-- current picture (completion, average mastery). These functions give activity over a date
-- range, which a view cannot take as a parameter. Both are for the organization's principal
-- only, count only active (not archived) classrooms and only lessons assigned to them, and
-- carry no layout or profile.
--
-- Time on task counts at most 60 seconds per event, which leaves out time left idle.

create index learning_events_user_time_idx on public.learning_events (user_id, occurred_at);

create function public.org_classroom_activity(p_org uuid, p_from date, p_to date)
returns table (classroom_id uuid, active_learners integer, active_seconds integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.org_role(p_org) is distinct from 'principal' then
    raise exception 'only the principal can see this' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'choose a date range of up to a year' using errcode = '22023';
  end if;

  return query
  select
    c.id,
    -- Only students who did something in the range count, not everyone on the roster.
    count(distinct e.student_id) filter (where ev.id is not null)::int,
    coalesce(round(sum(least(coalesce(ev.duration_ms, 0), 60000)) / 1000.0), 0)::int
  from public.classrooms c
  left join public.enrollments e on e.classroom_id = c.id
  left join public.assignments a on a.classroom_id = c.id
  left join public.learning_events ev
    on ev.user_id = e.student_id
   and ev.lesson_id = a.lesson_id
   and ev.occurred_at >= p_from::timestamptz
   and ev.occurred_at < (p_to + 1)::timestamptz
  where c.org_id = p_org and c.archived_at is null
  group by c.id;
end;
$$;

-- One row per week in the range: how many learners were active, how long they spent, and how
-- many ideas reached mastery. An idea is counted in the week its mastery record last changed,
-- so an idea that was mastered, lost and mastered again is counted once, in the later week.
create function public.org_weekly_activity(p_org uuid, p_from date, p_to date)
returns table (week_start date, active_learners integer, active_seconds integer, mastered_ideas integer)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.org_role(p_org) is distinct from 'principal' then
    raise exception 'only the principal can see this' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    raise exception 'choose a date range of up to a year' using errcode = '22023';
  end if;

  return query
  with weeks as (
    select d::date as wk
    from generate_series(date_trunc('week', p_from::timestamp), date_trunc('week', p_to::timestamp), interval '1 week') d
  ),
  roster as (
    select distinct e.student_id, a.lesson_id
    from public.classrooms c
    join public.enrollments e on e.classroom_id = c.id
    join public.assignments a on a.classroom_id = c.id
    where c.org_id = p_org and c.archived_at is null
  ),
  events as (
    select date_trunc('week', ev.occurred_at at time zone 'UTC')::date as wk,
           ev.user_id, least(coalesce(ev.duration_ms, 0), 60000) as ms
    from roster r
    join public.learning_events ev on ev.user_id = r.student_id and ev.lesson_id = r.lesson_id
    where ev.occurred_at >= p_from::timestamptz and ev.occurred_at < (p_to + 1)::timestamptz
  ),
  activity as (
    select wk, count(distinct user_id)::int as learners, round(sum(ms) / 1000.0)::int as seconds
    from events group by wk
  ),
  mastered as (
    select date_trunc('week', m.updated_at at time zone 'UTC')::date as wk, count(*)::int as ideas
    from public.concept_mastery m
    join public.concepts k on k.lesson_id = m.lesson_id and k.id = m.concept_id and not k.retired
    where m.status = 'mastered'
      and m.updated_at >= p_from::timestamptz and m.updated_at < (p_to + 1)::timestamptz
      and exists (select 1 from roster r where r.student_id = m.user_id and r.lesson_id = m.lesson_id)
    group by 1
  )
  select w.wk,
         coalesce(a.learners, 0),
         coalesce(a.seconds, 0),
         coalesce(ms.ideas, 0)
  from weeks w
  left join activity a on a.wk = w.wk
  left join mastered ms on ms.wk = w.wk
  order by w.wk;
end;
$$;

revoke all on function public.org_classroom_activity(uuid, date, date) from public, anon;
revoke all on function public.org_weekly_activity(uuid, date, date) from public, anon;
grant execute on function public.org_classroom_activity(uuid, date, date) to authenticated, service_role;
grant execute on function public.org_weekly_activity(uuid, date, date) to authenticated, service_role;
