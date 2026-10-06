-- Row-level security and grants for the content, learner, and sign tables
-- (PRD 5.8, 6.4). Every table has RLS enabled; this migration adds the only
-- policies, so anything not granted here stays unreachable.
--
-- Writes that must not come from a client (pipeline output, derived mastery, the
-- sign library) have no client policy. They run server side as the service role,
-- which bypasses RLS.

-- Policy helpers. They are security definer so a policy on one table can read
-- another without recursing into that table's own policies.

create function public.owns_lesson(p_lesson uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.lessons l where l.id = p_lesson and l.owner_id = auth.uid()
  )
$$;

-- Whether a user may read a lesson's learner-facing content. MVP rule: the owner, or
-- anyone once the lesson is published. The assignment, purchase, and preview paths
-- replace this body in the entitlement migration.
-- A signed-in caller can only ask about themselves; with no JWT (service role) the
-- user argument is trusted.
create function public.is_entitled(p_user uuid, p_lesson uuid) returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (auth.uid() is null or auth.uid() = p_user)
    and exists (
      select 1 from public.lessons l
      where l.id = p_lesson and (l.owner_id = p_user or l.status = 'published')
    )
$$;

revoke all on function public.owns_lesson(uuid) from public, anon;
revoke all on function public.is_entitled(uuid, uuid) from public, anon;
grant execute on function public.owns_lesson(uuid) to authenticated, service_role;
grant execute on function public.is_entitled(uuid, uuid) to authenticated, service_role;

-- users_public: any signed-in user can read display names. A user can change only
-- their own display name. is_creator is set server side by the creator flow.
grant select on public.users_public to authenticated;
grant update (display_name) on public.users_public to authenticated;

create policy users_public_select on public.users_public
  for select to authenticated
  using (true);

create policy users_public_update_own on public.users_public
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- lessons: owners manage their lessons; learners read published lessons they are
-- entitled to.
grant select, insert, update, delete on public.lessons to authenticated;

create policy lessons_select on public.lessons
  for select to authenticated
  using (owner_id = auth.uid() or (status = 'published' and public.is_entitled(auth.uid(), id)));

create policy lessons_insert_own on public.lessons
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy lessons_update_own on public.lessons
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy lessons_delete_own on public.lessons
  for delete to authenticated
  using (owner_id = auth.uid());

-- ingestion_jobs: owners can watch their job. The pipeline writes as the service role.
grant select on public.ingestion_jobs to authenticated;

create policy ingestion_jobs_select_owner on public.ingestion_jobs
  for select to authenticated
  using (public.owns_lesson(lesson_id));

-- concepts and quiz_items: readable by anyone entitled to the lesson, writable by its owner.
grant select, insert, update, delete on public.concepts, public.quiz_items to authenticated;

create policy concepts_select on public.concepts
  for select to authenticated
  using (public.is_entitled(auth.uid(), lesson_id));

create policy concepts_write_owner on public.concepts
  for all to authenticated
  using (public.owns_lesson(lesson_id))
  with check (public.owns_lesson(lesson_id));

create policy quiz_items_select on public.quiz_items
  for select to authenticated
  using (public.is_entitled(auth.uid(), lesson_id));

create policy quiz_items_write_owner on public.quiz_items
  for all to authenticated
  using (public.owns_lesson(lesson_id))
  with check (public.owns_lesson(lesson_id));

-- concept_variants: readable by entitled learners. Variants are generated and
-- cached server side, so there is no client write policy.
grant select on public.concept_variants to authenticated;

create policy concept_variants_select on public.concept_variants
  for select to authenticated
  using (public.is_entitled(auth.uid(), lesson_id));

-- render_profiles: private to the learner.
grant select, insert, update, delete on public.render_profiles to authenticated;

create policy render_profiles_own on public.render_profiles
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- learning_events: a learner reads and appends only their own events, and only for
-- lessons they are entitled to. Events are immutable once written.
grant select, insert on public.learning_events to authenticated;

create policy learning_events_select_own on public.learning_events
  for select to authenticated
  using (user_id = auth.uid());

create policy learning_events_insert_own on public.learning_events
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_entitled(auth.uid(), lesson_id));

-- concept_mastery: a learner reads their own. It is derived by trigger from events,
-- so clients cannot write it.
grant select on public.concept_mastery to authenticated;

create policy concept_mastery_select_own on public.concept_mastery
  for select to authenticated
  using (user_id = auth.uid());

-- unmet_needs: write-only for clients. Reviewed by staff through the service role.
grant insert on public.unmet_needs to authenticated;

create policy unmet_needs_insert on public.unmet_needs
  for insert to authenticated
  with check (user_id is null or user_id = auth.uid());

-- sign_clips: the library is readable by any signed-in user and managed server side.
grant select on public.sign_clips to authenticated;

create policy sign_clips_select on public.sign_clips
  for select to authenticated
  using (true);

-- concept_sign_links: learners see only verified links for lessons they can read.
-- Lesson owners see and manage all links, and can verify them only as themselves.
grant select, insert, update, delete on public.concept_sign_links to authenticated;

create policy concept_sign_links_select on public.concept_sign_links
  for select to authenticated
  using (
    public.owns_lesson(lesson_id)
    or (verified and public.is_entitled(auth.uid(), lesson_id))
  );

create policy concept_sign_links_insert_owner on public.concept_sign_links
  for insert to authenticated
  with check (
    public.owns_lesson(lesson_id) and (not verified or verified_by = auth.uid())
  );

create policy concept_sign_links_update_owner on public.concept_sign_links
  for update to authenticated
  using (public.owns_lesson(lesson_id))
  with check (
    public.owns_lesson(lesson_id) and (not verified or verified_by = auth.uid())
  );

create policy concept_sign_links_delete_owner on public.concept_sign_links
  for delete to authenticated
  using (public.owns_lesson(lesson_id));

-- Storage: signed-in users can read sign clips. Uploads happen server side.
create policy sign_clips_objects_select on storage.objects
  for select to authenticated
  using (bucket_id = 'sign-clips');
