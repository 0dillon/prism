-- Mastery (PRD 5.7). Identical for every renderer: it reads only learning_events and
-- never the layout.
--
--   not_started  no concept_viewed event (no row)
--   in_progress  viewed, and the mastered rule is not met
--   mastered     the two most recent answers on the concept's quiz items are both correct
--
-- The row is recomputed from the event log on each answer rather than updated
-- incrementally, so events that arrive late or out of order (offline queues) still
-- produce the right result. Runs as security definer because clients cannot write
-- concept_mastery.

create function public.apply_learning_event() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
  v_correct integer;
  v_last_two boolean;
begin
  if new.concept_id is null then
    return new;
  end if;

  -- Ignore events for concepts the lesson does not have, so a bad id cannot fail the insert.
  if not exists (
    select 1 from public.concepts c
    where c.lesson_id = new.lesson_id and c.id = new.concept_id
  ) then
    return new;
  end if;

  if new.type = 'concept_viewed' then
    insert into public.concept_mastery (user_id, lesson_id, concept_id, status)
    values (new.user_id, new.lesson_id, new.concept_id, 'in_progress')
    on conflict (user_id, lesson_id, concept_id) do nothing;
    return new;
  end if;

  if new.type = 'quiz_answered' and new.correct is not null then
    select count(*), count(*) filter (where e.correct)
      into v_attempts, v_correct
    from public.learning_events e
    where e.user_id = new.user_id
      and e.lesson_id = new.lesson_id
      and e.concept_id = new.concept_id
      and e.type = 'quiz_answered'
      and e.correct is not null;

    select coalesce(count(*) = 2 and bool_and(r.correct), false)
      into v_last_two
    from (
      select e.correct
      from public.learning_events e
      where e.user_id = new.user_id
        and e.lesson_id = new.lesson_id
        and e.concept_id = new.concept_id
        and e.type = 'quiz_answered'
        and e.correct is not null
      order by e.occurred_at desc, e.id desc
      limit 2
    ) r;

    insert into public.concept_mastery (
      user_id, lesson_id, concept_id, status, attempts, correct_count, last_two_correct
    )
    values (
      new.user_id, new.lesson_id, new.concept_id,
      case when v_last_two then 'mastered' else 'in_progress' end,
      v_attempts, v_correct, v_last_two
    )
    on conflict (user_id, lesson_id, concept_id) do update
      set status = excluded.status,
          attempts = excluded.attempts,
          correct_count = excluded.correct_count,
          last_two_correct = excluded.last_two_correct,
          updated_at = now();
  end if;

  return new;
end;
$$;

revoke all on function public.apply_learning_event() from public, anon, authenticated;

create trigger learning_events_apply
  after insert on public.learning_events
  for each row
  when (new.type in ('concept_viewed', 'quiz_answered'))
  execute function public.apply_learning_event();
