-- SECURITY DEFINER helpers used by row-level security policies.
--
-- Two reasons these exist rather than inlining the logic into policies.
--
-- 1. Recursion. A policy on a table whose predicate queries that same table re-triggers
--    itself, and Postgres raises "infinite recursion detected in policy". These helpers are
--    owned by `postgres`, so their bodies read the tables without policy evaluation, breaking
--    the cycle. (Relevant once org_memberships and classrooms land; the pattern is
--    established here so those policies have somewhere to go.)
--
-- 2. Evaluation cost. A set-returning helper is evaluated once per statement when used as
--    `id in (select ...)`, whereas a scalar function taking the row's own id is row-dependent
--    and runs once per candidate row. On a catalog listing that is the difference between one
--    query and an N+1.
--
-- Every function here is STABLE, has an empty search_path (so a mutable search_path cannot
-- redirect it to an attacker-controlled table), and is granted narrowly.

-- ---------------------------------------------------------------------------
-- Lessons the caller owns.
-- ---------------------------------------------------------------------------
create or replace function private.my_lesson_ids()
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select id from public.lessons where owner_id = (select auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Lessons the caller may read.
--
-- PRD task P1-14 defines four entitlement paths: ownership, enrolment in a classroom the
-- lesson is assigned to, a paid purchase of a course containing it, and preview lessons.
--
-- Only two of those are reachable today. The MVP has no organizations and no marketplace
-- (PRD 8.0), so `assignments`, `enrollments`, `purchases` and `course_lessons` do not exist
-- yet. Until they do, a published lesson is readable by any authenticated learner, which is
-- what makes the seeded demo work.
--
-- THIS IS AN MVP WIDENING AND IT MUST BE NARROWED. When Phase 6 and Phase 7 land, the
-- `status = 'published'` branch below is replaced by the enrolment, purchase and preview
-- branches. Recorded in PRD section 9.1. Draft lessons are never caught by this: an
-- unpublished lesson is visible to its owner alone, today and afterwards.
-- ---------------------------------------------------------------------------
create or replace function private.entitled_lesson_ids(p_user_id uuid)
returns setof uuid
language sql
security definer
stable
set search_path = ''
as $$
  select id from public.lessons where owner_id = p_user_id
  union
  select id from public.lessons where status = 'published'
$$;

-- The scalar form PRD task P1-14 names. Built on the set helper so the two can never disagree,
-- while policies use the set form to keep evaluation per-statement.
create or replace function public.is_entitled(p_user_id uuid, p_lesson_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select p_lesson_id in (select private.entitled_lesson_ids(p_user_id))
$$;

comment on function public.is_entitled(uuid, uuid) is
  'True when the user may read the lesson. See private.entitled_lesson_ids for the paths, '
  'and note the MVP widening documented there.';

-- ---------------------------------------------------------------------------
-- Whether the caller may see a given learner's data.
--
-- Today: only the learner themselves. Teachers gain access to their own students once
-- classrooms and enrolments exist (PRD 5.8), at which point only this body changes - every
-- policy that calls it is already written in its final shape.
--
-- Note this is about *progress*, not profiles. A learner's Render Profile additionally
-- requires that learner to have opted in (PRD B2B-5), which the policy checks separately.
-- ---------------------------------------------------------------------------
create or replace function private.can_view_student(p_student_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select p_student_id = (select auth.uid())
$$;

-- ---------------------------------------------------------------------------
-- Concepts belonging to lessons the caller may read. Used by the variant and sign-link
-- policies so neither has to re-derive entitlement.
-- ---------------------------------------------------------------------------
create or replace function private.entitled_concept_ids()
returns setof text
language sql
security definer
stable
set search_path = ''
as $$
  select c.id
  from public.concepts c
  where c.lesson_id in (select private.entitled_lesson_ids((select auth.uid())))
$$;

-- ---------------------------------------------------------------------------
-- Grants. Default-deny was set on the schema, so each function is granted explicitly.
-- ---------------------------------------------------------------------------
revoke all on function private.my_lesson_ids() from public;
revoke all on function private.entitled_lesson_ids(uuid) from public;
revoke all on function private.can_view_student(uuid) from public;
revoke all on function private.entitled_concept_ids() from public;
revoke all on function public.is_entitled(uuid, uuid) from public;

grant execute on function private.my_lesson_ids() to authenticated;
grant execute on function private.entitled_lesson_ids(uuid) to authenticated;
grant execute on function private.can_view_student(uuid) to authenticated;
grant execute on function private.entitled_concept_ids() to authenticated;
grant execute on function public.is_entitled(uuid, uuid) to authenticated;
