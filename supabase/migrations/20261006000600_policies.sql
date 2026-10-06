-- Row-level security policies.
--
-- Conventions applied without exception, each for a reason:
--
-- * Every policy names its role with TO. An unqualified policy is evaluated for roles it was
--   never meant for, which is both a correctness hazard and a review hazard.
-- * Every auth.uid() is written `(select auth.uid())`. That form is cached as an initPlan and
--   evaluated once per statement rather than once per row - on a large concept_mastery scan
--   it is the difference between a fast dashboard and a timeout.
-- * Grants are issued per table and per operation. A table with no INSERT grant cannot be
--   written even if a permissive policy is added later by mistake.
-- * Absence of a policy is a deliberate, documented decision, not an oversight. Tables
--   written only by trusted server-side code have no write policy at all, so there is no
--   client-reachable path to them.

-- ===========================================================================
-- users_public
-- ===========================================================================
create policy users_public_select_self on public.users_public
  for select to authenticated
  using (id = (select auth.uid()));

-- Creators are publicly attributable; nothing else about a user is.
create policy users_public_select_creators on public.users_public
  for select to anon, authenticated
  using (is_creator);

create policy users_public_update_self on public.users_public
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

grant select on public.users_public to anon, authenticated;
-- Only display_name is self-settable. is_creator must not be, or a learner could grant
-- themselves the creator surface by updating their own row.
grant update (display_name) on public.users_public to authenticated;

-- ===========================================================================
-- lessons
-- ===========================================================================
create policy lessons_select_entitled on public.lessons
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or id in (select private.entitled_lesson_ids((select auth.uid())))
  );

create policy lessons_insert_own on public.lessons
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy lessons_update_own on public.lessons
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- A published lesson may have learner progress attached to it, so deleting one would orphan
-- that history. Published lessons are retired through status, never removed.
create policy lessons_delete_own_draft on public.lessons
  for delete to authenticated
  using (owner_id = (select auth.uid()) and status <> 'published');

grant select, insert, update, delete on public.lessons to authenticated;

-- ===========================================================================
-- ingestion_jobs and ingestion_artifacts
--
-- Readable and writable by the lesson owner only. Background workers reach these through an
-- owner-impersonated session rather than the privileged pool, which keeps the largest surface
-- in the product - the ingestion pipeline - outside the service-role blast radius.
-- ===========================================================================
create policy ingestion_jobs_owner on public.ingestion_jobs
  for all to authenticated
  using (lesson_id in (select private.my_lesson_ids()))
  with check (lesson_id in (select private.my_lesson_ids()));

grant select, insert, update on public.ingestion_jobs to authenticated;

create policy ingestion_artifacts_owner on public.ingestion_artifacts
  for all to authenticated
  using (
    job_id in (
      select j.id from public.ingestion_jobs j
      where j.lesson_id in (select private.my_lesson_ids())
    )
  )
  with check (
    job_id in (
      select j.id from public.ingestion_jobs j
      where j.lesson_id in (select private.my_lesson_ids())
    )
  );

grant select, insert, update, delete on public.ingestion_artifacts to authenticated;

-- ===========================================================================
-- concepts and quiz_items
--
-- Read-only to clients. There is deliberately NO insert, update or delete policy and no write
-- grant: these rows are written exclusively by publish_lesson(), which is SECURITY DEFINER and
-- re-checks ownership itself. A learner therefore has no reachable path to mutate curriculum.
--
-- The `retired` filter lives in the policy rather than in queries, so a forgotten WHERE clause
-- in application code cannot surface deleted content to a learner.
-- ===========================================================================
create policy concepts_select_entitled on public.concepts
  for select to authenticated
  using (
    lesson_id in (select private.my_lesson_ids())
    or (
      not retired
      and lesson_id in (select private.entitled_lesson_ids((select auth.uid())))
    )
  );

grant select on public.concepts to authenticated;

create policy quiz_items_select_entitled on public.quiz_items
  for select to authenticated
  using (
    lesson_id in (select private.my_lesson_ids())
    or (
      not retired
      and lesson_id in (select private.entitled_lesson_ids((select auth.uid())))
    )
  );

grant select on public.quiz_items to authenticated;

-- ===========================================================================
-- concept_variants
--
-- Read-only to clients, for a specific reason: the cache is keyed on
-- (concept_id, graph_version, reading_level) and shared by every learner of that lesson. A
-- client-writable policy here would be a stored content-injection vector - one learner could
-- replace the lesson text that everyone else reads. Writes go through the server-side
-- get-or-create path only.
-- ===========================================================================
create policy concept_variants_select_entitled on public.concept_variants
  for select to authenticated
  using (concept_id in (select private.entitled_concept_ids()));

grant select on public.concept_variants to authenticated;

-- ===========================================================================
-- render_profiles
--
-- The privacy centrepiece (PRD 6.4, B2B-5, task P1-07).
--
-- The sharing branch reads `share_with_teachers` on the row being filtered, so there is no
-- recursion and no subquery. Today can_view_student() is true only for the learner themselves;
-- when classrooms land, that helper changes and this policy does not.
-- ===========================================================================
create policy render_profiles_select_own_or_shared on public.render_profiles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (share_with_teachers and private.can_view_student(user_id))
  );

create policy render_profiles_insert_own on public.render_profiles
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy render_profiles_update_own on public.render_profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select, insert, update on public.render_profiles to authenticated;

-- ===========================================================================
-- learning_events
--
-- Append-only, and readable by the learner alone.
--
-- There is deliberately no teacher or principal read policy. Row-level access would expose
-- `layout`, and PRD 5.7 forbids revealing which renderer an individual learner uses outside
-- the suppressed aggregate. Teachers read concept_mastery and the dashboard views instead.
--
-- The INSERT check is the database-level enforcement of "never trust a client-supplied user
-- id" (PRD P5-02). The API also stamps the authenticated principal; this is the second,
-- independent layer, and it is the one that holds if the first is ever bypassed.
-- ===========================================================================
create policy learning_events_select_own on public.learning_events
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy learning_events_insert_own on public.learning_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- No UPDATE or DELETE policy and no grant: the event log is append-only.
grant select, insert on public.learning_events to authenticated;

-- ===========================================================================
-- concept_mastery
--
-- Derived state. Written only by the trigger on learning_events, which is SECURITY DEFINER.
-- No write policy and no write grant: a learner cannot declare themselves to have mastered
-- anything, they can only answer questions correctly.
-- ===========================================================================
create policy concept_mastery_select_visible on public.concept_mastery
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.can_view_student(user_id)
  );

grant select on public.concept_mastery to authenticated;

-- ===========================================================================
-- unmet_needs
--
-- A learner may record a need and read their own. Anonymous visitors can file one during
-- onboarding before sign-up (PRD 5.4A), rate limited at the API.
-- ===========================================================================
create policy unmet_needs_select_own on public.unmet_needs
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy unmet_needs_insert_own on public.unmet_needs
  for insert to authenticated
  with check (user_id = (select auth.uid()) or user_id is null);

create policy unmet_needs_insert_anonymous on public.unmet_needs
  for insert to anon
  with check (user_id is null);

grant select, insert on public.unmet_needs to authenticated;
grant insert on public.unmet_needs to anon;

-- ===========================================================================
-- sign_clips and concept_sign_links
--
-- The clip library is shared reference data. Links are visible to learners only once a
-- teacher has verified them, enforced in the policy so an unreviewed AI-proposed match can
-- never reach a learner through a forgotten filter (PRD P2-16).
-- ===========================================================================
create policy sign_clips_select_all on public.sign_clips
  for select to anon, authenticated
  using (true);

grant select on public.sign_clips to anon, authenticated;

create policy concept_sign_links_select_verified on public.concept_sign_links
  for select to authenticated
  using (
    (verified and concept_id in (select private.entitled_concept_ids()))
    or concept_id in (
      select c.id from public.concepts c
      where c.lesson_id in (select private.my_lesson_ids())
    )
  );

-- The lesson owner verifies or removes a proposed link during review.
create policy concept_sign_links_write_owner on public.concept_sign_links
  for update to authenticated
  using (
    concept_id in (
      select c.id from public.concepts c
      where c.lesson_id in (select private.my_lesson_ids())
    )
  )
  with check (
    concept_id in (
      select c.id from public.concepts c
      where c.lesson_id in (select private.my_lesson_ids())
    )
  );

create policy concept_sign_links_delete_owner on public.concept_sign_links
  for delete to authenticated
  using (
    concept_id in (
      select c.id from public.concepts c
      where c.lesson_id in (select private.my_lesson_ids())
    )
  );

grant select, update, delete on public.concept_sign_links to authenticated;

-- ===========================================================================
-- audit_log
--
-- Readable by the actor. Written only by SECURITY DEFINER triggers and server-side code, and
-- immutable once written (enforced by trigger in the previous migration).
-- ===========================================================================
create policy audit_log_select_own on public.audit_log
  for select to authenticated
  using (actor_id = (select auth.uid()));

grant select on public.audit_log to authenticated;

-- ===========================================================================
-- Server-only tables.
--
-- llm_usage, idempotency_keys and rate_limit_counters get no policy and no grant at all.
-- RLS is enabled and forced on each, so they are deny-all to `authenticated` and `anon`.
-- They are reached only through the privileged session, which is import-banned outside an
-- allowlist. Listing them here explicitly so their absence reads as a decision.
-- ===========================================================================
