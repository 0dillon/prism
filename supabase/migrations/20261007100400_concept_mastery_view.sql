-- One row per student, assigned lesson and idea in a classroom, for the teacher's mastery
-- grid (PRD 5.8, P6-06). An idea nobody has been asked about yet is 'not_started', so the grid
-- has a cell for every student and every idea. Like the other dashboard views it runs with
-- the owner's rights and returns only the caller's own classrooms, or the organization's for
-- a principal. It carries no layout and no profile.

create view public.v_classroom_concept_mastery as
select
  c.id as classroom_id,
  e.student_id,
  u.display_name,
  a.lesson_id,
  k.id as concept_id,
  k.title as concept_title,
  k.order_index,
  coalesce(m.status, 'not_started') as status,
  coalesce(m.attempts, 0)::int as attempts,
  coalesce(m.correct_count, 0)::int as correct
from public.classrooms c
join public.enrollments e on e.classroom_id = c.id
join public.users_public u on u.id = e.student_id
join public.assignments a on a.classroom_id = c.id
join public.concepts k on k.lesson_id = a.lesson_id and not k.retired
left join public.concept_mastery m
  on m.user_id = e.student_id and m.lesson_id = k.lesson_id and m.concept_id = k.id
where public.is_classroom_teacher(c.id) or public.is_classroom_principal(c.id);

grant select on public.v_classroom_concept_mastery to authenticated;
