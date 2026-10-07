-- Student privacy (PRD 5.8, 6.4, P6-08, P6-09).
--
-- A learner's Render Profile can reveal how they need to learn, so a teacher or principal
-- sees it only if the learner has opted in. The opt-in flag changes only through
-- set_profile_sharing, which writes the audit log in the same step, so a change cannot
-- happen without a record. The profile itself is still written by the learner directly.

revoke insert, update on public.render_profiles from authenticated;
grant insert (user_id, profile) on public.render_profiles to authenticated;
grant update (profile) on public.render_profiles to authenticated;

create function public.set_profile_sharing(p_share boolean) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_old boolean;
  v_org uuid;
  v_logged boolean := false;
begin
  if v_user is null then
    raise exception 'sign in required' using errcode = '28000';
  end if;

  select share_with_teachers into v_old from public.render_profiles where user_id = v_user for update;
  if not found then
    raise exception 'save your settings before choosing to share them' using errcode = 'P0002';
  end if;
  if v_old = p_share then
    return p_share;
  end if;

  update public.render_profiles set share_with_teachers = p_share where user_id = v_user;

  -- One entry for each school the learner belongs to, so each school's principal can see
  -- that the choice changed. The entry holds no settings, only the new choice.
  for v_org in select org_id from public.org_memberships where user_id = v_user loop
    insert into public.audit_log (org_id, actor_id, action, target, metadata)
    values (v_org, v_user, 'profile_sharing.changed', v_user::text,
            jsonb_build_object('shared', p_share));
    v_logged := true;
  end loop;
  if not v_logged then
    insert into public.audit_log (org_id, actor_id, action, target, metadata)
    values (null, v_user, 'profile_sharing.changed', v_user::text, jsonb_build_object('shared', p_share));
  end if;

  return p_share;
end;
$$;

-- The learner's settings, for the teacher or principal of a class they are in, and only if the
-- learner has chosen to share. Anything else returns null, so "not shared" and "not allowed"
-- look the same.
create function public.get_shared_profile(p_classroom uuid, p_student uuid) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select p.profile
  from public.render_profiles p
  where p.user_id = p_student
    and p.share_with_teachers
    and (public.is_classroom_teacher(p_classroom) or public.is_classroom_principal(p_classroom))
    and exists (
      select 1 from public.enrollments e
      where e.classroom_id = p_classroom and e.student_id = p_student
    )
$$;

revoke all on function public.set_profile_sharing(boolean) from public, anon;
revoke all on function public.get_shared_profile(uuid, uuid) from public, anon;
grant execute on function public.set_profile_sharing(boolean) to authenticated, service_role;
grant execute on function public.get_shared_profile(uuid, uuid) to authenticated, service_role;

-- The student detail page also shows when each student last worked on a lesson.
create or replace view public.v_classroom_student_progress as
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
    where ev.user_id = e.student_id and ev.lesson_id = a.lesson_id)::int as active_seconds,
  (select max(ev.occurred_at) from public.learning_events ev
    where ev.user_id = e.student_id and ev.lesson_id = a.lesson_id) as last_active_at
from public.classrooms c
join public.enrollments e on e.classroom_id = c.id
join public.assignments a on a.classroom_id = c.id
join public.users_public u on u.id = e.student_id
where public.is_classroom_teacher(c.id) or public.is_classroom_principal(c.id);
