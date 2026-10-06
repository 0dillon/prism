-- Atomic lesson publication (PRD 5.1 step 10, task P2-14, brief section 18).
--
-- Publishing must never produce a half-applied state: a bumped graph_version with concepts
-- not updated, or quiz items partially written. So the whole sequence is one function and one
-- round trip - validate ownership, bump the version, upsert concepts, upsert quiz items,
-- retire removed ids, set status - rather than five statements orchestrated from Python where
-- an HTTP disconnect or a worker restart could land between any two of them.
--
-- It is SECURITY DEFINER for a second reason beyond atomicity: it lets `concepts` and
-- `quiz_items` keep no write policy and no write grant at all, so there is no client-reachable
-- path that mutates curriculum. Because SECURITY DEFINER bypasses RLS, the ownership check
-- below is the entire authorization boundary of this function, which is why it is the first
-- thing that runs.
--
-- Stable ids are the point of the upserts. An unchanged or merely edited concept keeps its id
-- across versions, so concept_mastery rows keyed to it survive republication untouched
-- (PRD 5.2, CE-2, task P2-22). Deleted items are retired, never deleted: historical Learning
-- Events still reference them, and reusing an id would silently rewrite that history.

create or replace function public.publish_lesson(p_lesson_id uuid, p_graph jsonb)
returns table (
  graph_version      integer,
  concepts_upserted  integer,
  quiz_upserted      integer,
  concepts_retired   integer,
  quiz_retired       integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor       uuid := (select auth.uid());
  v_version     integer;
  v_concept_ids text[];
  v_quiz_ids    text[];
  v_count       integer;
begin
  if v_actor is null then
    raise exception 'publish requires an authenticated user' using errcode = '42501';
  end if;

  -- Ownership check and serialisation in one statement. FOR UPDATE holds the row for the
  -- transaction, so two concurrent publishes of the same lesson cannot both read the same
  -- graph_version and both increment it to the same number.
  select l.graph_version into v_version
  from public.lessons l
  where l.id = p_lesson_id and l.owner_id = v_actor
  for update;

  if not found then
    -- Deliberately indistinguishable from "no such lesson". A distinct error here would
    -- confirm the lesson exists to someone who may not see it.
    raise exception 'lesson not found' using errcode = '42501';
  end if;

  if (p_graph ->> 'lessonId') is distinct from p_lesson_id::text then
    raise exception 'graph lessonId does not match the lesson being published'
      using errcode = '22023';
  end if;

  select array_agg(c ->> 'id') into v_concept_ids
  from jsonb_array_elements(p_graph -> 'concepts') c;

  select coalesce(array_agg(q ->> 'id'), array[]::text[]) into v_quiz_ids
  from jsonb_array_elements(coalesce(p_graph -> 'quizItems', '[]'::jsonb)) q;

  if v_concept_ids is null or array_length(v_concept_ids, 1) is null then
    raise exception 'a published graph must contain at least one concept'
      using errcode = '22023';
  end if;

  -- Concept and quiz ids are globally unique ULIDs. If one already belongs to a different
  -- lesson, the upsert below would silently move it, taking its mastery history with it.
  if exists (
    select 1 from public.concepts c
    where c.id = any (v_concept_ids) and c.lesson_id <> p_lesson_id
  ) then
    raise exception 'a concept id in this graph belongs to a different lesson'
      using errcode = '23505';
  end if;

  if exists (
    select 1 from public.quiz_items q
    where q.id = any (v_quiz_ids) and q.lesson_id <> p_lesson_id
  ) then
    raise exception 'a quiz item id in this graph belongs to a different lesson'
      using errcode = '23505';
  end if;

  v_version := v_version + 1;

  update public.lessons
     set graph         = p_graph,
         graph_version = v_version,
         status        = 'published',
         title         = coalesce(nullif(p_graph ->> 'title', ''), public.lessons.title)
   where id = p_lesson_id;

  -- Concepts first: quiz_items references them.
  insert into public.concepts (
    id, lesson_id, graph_version, order_index, section_id, title, summary, key_term, retired
  )
  select c ->> 'id',
         p_lesson_id,
         v_version,
         (c ->> 'order')::integer,
         c ->> 'sectionId',
         c ->> 'title',
         coalesce(c ->> 'summary', ''),
         nullif(c ->> 'keyTerm', ''),
         false
  from jsonb_array_elements(p_graph -> 'concepts') c
  on conflict (id) do update
     set graph_version = excluded.graph_version,
         order_index   = excluded.order_index,
         section_id    = excluded.section_id,
         title         = excluded.title,
         summary       = excluded.summary,
         key_term      = excluded.key_term,
         -- A concept deleted in one version and restored in a later one comes back rather
         -- than staying invisible.
         retired       = false;
  get diagnostics v_count = row_count;
  concepts_upserted := v_count;

  insert into public.quiz_items (id, lesson_id, concept_id, type, retired)
  select q ->> 'id',
         p_lesson_id,
         q ->> 'conceptId',
         (q ->> 'type')::public.quiz_item_type,
         false
  from jsonb_array_elements(coalesce(p_graph -> 'quizItems', '[]'::jsonb)) q
  on conflict (id) do update
     set concept_id = excluded.concept_id,
         type       = excluded.type,
         retired    = false;
  get diagnostics v_count = row_count;
  quiz_upserted := v_count;

  -- Retire what the new graph no longer contains. Quiz items first, so a retired concept
  -- never has live quiz items pointing at it.
  update public.quiz_items
     set retired = true
   where lesson_id = p_lesson_id
     and not (id = any (v_quiz_ids))
     and not retired;
  get diagnostics v_count = row_count;
  quiz_retired := v_count;

  update public.concepts
     set retired = true
   where lesson_id = p_lesson_id
     and not (id = any (v_concept_ids))
     and not retired;
  get diagnostics v_count = row_count;
  concepts_retired := v_count;

  insert into public.audit_log (actor_id, action, target, metadata)
  values (
    v_actor,
    'lesson_published',
    'lessons:' || p_lesson_id::text,
    jsonb_build_object(
      'graph_version', v_version,
      'concepts', concepts_upserted,
      'quiz_items', quiz_upserted,
      'concepts_retired', concepts_retired,
      'quiz_items_retired', quiz_retired
    )
  );

  graph_version := v_version;
  return next;
end
$$;

revoke all on function public.publish_lesson(uuid, jsonb) from public, anon;
grant execute on function public.publish_lesson(uuid, jsonb) to authenticated;

comment on function public.publish_lesson(uuid, jsonb) is
  'Atomically publishes a validated Knowledge Graph. Re-checks ownership because '
  'SECURITY DEFINER bypasses row-level security. Preserves stable concept and quiz ids so '
  'learner mastery survives republication.';
