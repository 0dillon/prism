-- Entitlements (PRD 5.8, 5.9): replaces the MVP stub body of is_entitled.
--
-- A user may read a lesson's learner-facing content when it is theirs, or when it is
-- published and one of these holds:
--   1. they are enrolled in a classroom the lesson is assigned to;
--   2. they have a paid purchase of a course that contains it (and the course is not
--      suspended; a refund sets the purchase to 'refunded', which ends access);
--   3. it is the free preview lesson of a published course.
--
-- Every learner-facing policy already calls is_entitled, so this one function changes
-- lesson, concept, quiz, variant, sign-link and event access together.
-- A signed-in caller can only ask about themselves; with no JWT (service role) the
-- user argument is trusted.

create or replace function public.is_entitled(p_user uuid, p_lesson uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (auth.uid() is null or auth.uid() = p_user)
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
