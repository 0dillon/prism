-- Dashboard views (PRD 5.8). Teachers and principals do not read learning_events or
-- concept_mastery directly, because those tables are private to the learner. These views
-- are the only way in. They run with the owner's rights, so each one restricts its own
-- rows to what the signed-in user may see (their classrooms for a teacher, the whole
-- organization for a principal) using the same helpers as the table policies.
--
-- Progress everywhere is ideas mastered over ideas in the lesson as it is now, whichever
-- layout the learner used. Layout is not exposed per learner: v_org_layout_usage is an
-- organization-wide count with every group of fewer than five learners removed.

-- Active time counts at most 60 seconds per event, which leaves out time left idle.

create view public.v_classroom_student_progress as
select
  c.id as classroom_id,
  e.student_id,
  u.display_name,
  a.lesson_id,
  (select count(*) from public.concepts k
    where k.lesson_id = a.lesson_id and not k.retired)::int as total_concepts,
  (select count(*) from public.concept_mastery m
    join public.concepts k on k.lesson_id = m.lesson_id and k.id = m.concept_id and not k.retired
    where m.user_id = e.student_id and m.lesson_id = a.lesson_id and m.status = 'mastered')::int
    as mastered_concepts,
  (select coalesce(sum(m.attempts), 0) from public.concept_mastery m
    join public.concepts k on k.lesson_id = m.lesson_id and k.id = m.concept_id and not k.retired
    where m.user_id = e.student_id and m.lesson_id = a.lesson_id)::int as answered,
  (select coalesce(sum(m.correct_count), 0) from public.concept_mastery m
    join public.concepts k on k.lesson_id = m.lesson_id and k.id = m.concept_id and not k.retired
    where m.user_id = e.student_id and m.lesson_id = a.lesson_id)::int as correct,
  (select coalesce(round(sum(least(coalesce(ev.duration_ms, 0), 60000)) / 1000.0), 0)
    from public.learning_events ev
    where ev.user_id = e.student_id and ev.lesson_id = a.lesson_id)::int as active_seconds
from public.classrooms c
join public.enrollments e on e.classroom_id = c.id
join public.assignments a on a.classroom_id = c.id
join public.users_public u on u.id = e.student_id
where public.is_classroom_teacher(c.id) or public.is_classroom_principal(c.id);

create view public.v_classroom_concept_difficulty as
select
  c.id as classroom_id,
  a.lesson_id,
  k.id as concept_id,
  k.title as concept_title,
  coalesce(sum(m.attempts), 0)::int as attempts,
  coalesce(sum(m.correct_count), 0)::int as correct,
  case
    when coalesce(sum(m.attempts), 0) = 0 then null
    else round(1 - sum(m.correct_count)::numeric / sum(m.attempts), 3)
  end as error_rate
from public.classrooms c
join public.assignments a on a.classroom_id = c.id
join public.concepts k on k.lesson_id = a.lesson_id and not k.retired
left join public.enrollments e on e.classroom_id = c.id
left join public.concept_mastery m
  on m.user_id = e.student_id and m.lesson_id = k.lesson_id and m.concept_id = k.id
where public.is_classroom_teacher(c.id) or public.is_classroom_principal(c.id)
group by c.id, a.lesson_id, k.id, k.title, k.order_index;

-- One row per classroom for the principal: how many students, how many have done
-- something in the last seven days, how many assigned lessons are finished, and the
-- average share of ideas mastered across every (student, assigned lesson) pair.
create view public.v_org_classroom_summary as
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
where public.org_role(c.org_id) = 'principal'
group by c.org_id, c.id, c.name, c.teacher_id;

-- Layout share across the organization. A learner counts once per layout they have used.
-- A layout used by fewer than five learners is left out, and the shares are taken over
-- the groups that remain, so a hidden group cannot be worked out from the rest.
create view public.v_org_layout_usage as
with usage as (
  select c.org_id, ev.layout, count(distinct ev.user_id) as learners
  from public.classrooms c
  join public.enrollments e on e.classroom_id = c.id
  join public.learning_events ev on ev.user_id = e.student_id
  where public.org_role(c.org_id) = 'principal'
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

grant select on public.v_classroom_student_progress to authenticated;
grant select on public.v_classroom_concept_difficulty to authenticated;
grant select on public.v_org_classroom_summary to authenticated;
grant select on public.v_org_layout_usage to authenticated;
