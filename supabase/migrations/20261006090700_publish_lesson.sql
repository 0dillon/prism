-- Publishing a lesson (PRD 5.1 step 10, task P2-14).
--
-- One function does the whole publish so it is all or nothing: validate state, bump the
-- graph version, write the normalized concepts and quiz_items, retire the ones the graph
-- no longer has, and flip the lesson to published. It runs with the caller's privileges
-- (security invoker), so row-level security still decides who may do it: only the
-- lesson's owner passes the owns_lesson check.
--
-- Concepts and quiz items are never deleted here, only retired. Learner progress rows
-- reference concept ids, so keeping the row keeps the progress.

create function public.publish_lesson(p_lesson_id uuid, p_graph jsonb) returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  v_version integer;
  v_concept_ids text[];
  v_quiz_ids text[];
begin
  if auth.uid() is null or not public.owns_lesson(p_lesson_id) then
    raise exception 'lesson not found' using errcode = 'P0002';
  end if;

  select status, graph_version into v_status, v_version
  from public.lessons
  where id = p_lesson_id
  for update;

  if v_status is distinct from 'needs_review' then
    raise exception 'lesson is not ready to publish' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_graph -> 'concepts') is distinct from 'array'
     or jsonb_array_length(p_graph -> 'concepts') = 0 then
    raise exception 'graph has no concepts' using errcode = 'P0001';
  end if;

  v_version := v_version + 1;

  -- Concepts: upsert every concept in the graph, un-retiring any that came back.
  insert into public.concepts (id, lesson_id, graph_version, order_index, title, summary, key_term, retired)
  select c ->> 'id',
         p_lesson_id,
         v_version,
         (c ->> 'order')::integer,
         c ->> 'title',
         c ->> 'summary',
         nullif(c ->> 'keyTerm', ''),
         false
  from jsonb_array_elements(p_graph -> 'concepts') as c
  on conflict (lesson_id, id) do update
    set graph_version = excluded.graph_version,
        order_index = excluded.order_index,
        title = excluded.title,
        summary = excluded.summary,
        key_term = excluded.key_term,
        retired = false;

  select array_agg(c ->> 'id') into v_concept_ids
  from jsonb_array_elements(p_graph -> 'concepts') as c;

  update public.concepts
  set retired = true
  where lesson_id = p_lesson_id and id <> all (v_concept_ids) and not retired;

  -- Quiz items.
  insert into public.quiz_items (id, lesson_id, concept_id, type, retired)
  select q ->> 'id', p_lesson_id, q ->> 'conceptId', q ->> 'type', false
  from jsonb_array_elements(coalesce(p_graph -> 'quizItems', '[]'::jsonb)) as q
  on conflict (lesson_id, id) do update
    set concept_id = excluded.concept_id,
        type = excluded.type,
        retired = false;

  select coalesce(array_agg(q ->> 'id'), array[]::text[]) into v_quiz_ids
  from jsonb_array_elements(coalesce(p_graph -> 'quizItems', '[]'::jsonb)) as q;

  update public.quiz_items
  set retired = true
  where lesson_id = p_lesson_id and id <> all (v_quiz_ids) and not retired;

  update public.lessons
  set graph = p_graph,
      graph_version = v_version,
      status = 'published',
      title = coalesce(nullif(p_graph ->> 'title', ''), title)
  where id = p_lesson_id;

  return v_version;
end;
$$;

revoke all on function public.publish_lesson(uuid, jsonb) from public, anon;
grant execute on function public.publish_lesson(uuid, jsonb) to authenticated, service_role;
