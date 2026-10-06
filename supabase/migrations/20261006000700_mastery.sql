-- Concept mastery, maintained on insert of learning events (PRD 5.7, task P1-08).
--
-- | Status        | Rule                                                                      |
-- | ------------- | ------------------------------------------------------------------------- |
-- | not_started   | No concept_viewed event                                                   |
-- | in_progress   | Viewed, and the mastered rule is not met                                  |
-- | mastered      | The two most recent answers on that concept's quiz items are both correct |
--
-- WHY THIS RECOMPUTES RATHER THAN INCREMENTS
--
-- PRD 7.4 names a `last_two_correct` column, which invites an incremental implementation:
-- watch each incoming answer and update a running flag. That implementation is unsound here.
--
-- Clients batch events every five seconds and on page hide, persist unsent events locally,
-- and retry with backoff (PRD 6.5). Delivery is therefore at-least-once and arrival order is
-- not event order. Consider a learner who answers correctly, correctly, then wrongly, where
-- the third event is delivered first because the first two were queued offline:
--
--     arrival order:  wrong@t3, correct@t1, correct@t2   -> a counter concludes MASTERED
--     true history:   correct@t1, correct@t2, wrong@t3   -> the rule says IN_PROGRESS
--
-- So mastery is computed as a pure function of the event set, ordered by occurred_at. Any
-- arrival order converges on the same answer, and replaying a batch changes nothing.
-- `last_two_correct` survives as a cache of that computed boolean. Recorded in PRD 9.1.
--
-- Replays never reach this trigger at all: learning_events.id is the client ULID primary key
-- and inserts use ON CONFLICT DO NOTHING, so a duplicate event is not an insert. The function
-- is idempotent regardless, which is what makes that safe rather than merely lucky.

create or replace function private.recompute_concept_mastery(
  p_user_id    uuid,
  p_lesson_id  uuid,
  p_concept_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recent   boolean[];
  v_attempts integer := 0;
  v_correct  integer := 0;
  v_viewed   boolean := false;
  v_status   public.mastery_status;
begin
  -- The two most recent answers, newest first. The ORDER BY inside array_agg is what makes
  -- position 1 the newest; the subquery's own ORDER BY ... LIMIT 2 is what makes it cheap.
  --
  -- id DESC is a real tiebreak rather than a coin flip: two items answered within the same
  -- millisecond would otherwise give nondeterministic mastery, and client ULIDs are
  -- monotonic within a client.
  select coalesce(array_agg(correct order by occurred_at desc, id desc), array[]::boolean[])
    into v_recent
  from (
    select e.correct, e.occurred_at, e.id
    from public.learning_events e
    where e.user_id = p_user_id
      and e.concept_id = p_concept_id
      and e.type = 'quiz_answered'
      and e.correct is not null
    order by e.occurred_at desc, e.id desc
    limit 2
  ) newest;

  select count(*), count(*) filter (where e.correct)
    into v_attempts, v_correct
  from public.learning_events e
  where e.user_id = p_user_id
    and e.concept_id = p_concept_id
    and e.type = 'quiz_answered'
    and e.correct is not null;

  select exists (
    select 1 from public.learning_events e
    where e.user_id = p_user_id
      and e.concept_id = p_concept_id
      and e.type = 'concept_viewed'
  ) into v_viewed;

  v_status := case
    when array_length(v_recent, 1) = 2 and v_recent[1] and v_recent[2] then 'mastered'
    when v_viewed or v_attempts > 0 then 'in_progress'
    else 'not_started'
  end;

  insert into public.concept_mastery as cm (
    user_id, lesson_id, concept_id, status, attempts, correct_count,
    last_two_correct, updated_at
  )
  values (
    p_user_id, p_lesson_id, p_concept_id, v_status, v_attempts, v_correct,
    v_status = 'mastered', now()
  )
  on conflict (user_id, concept_id) do update
    set status           = excluded.status,
        attempts         = excluded.attempts,
        correct_count    = excluded.correct_count,
        last_two_correct = excluded.last_two_correct,
        lesson_id        = excluded.lesson_id,
        updated_at       = now();
end
$$;

comment on function private.recompute_concept_mastery(uuid, uuid, text) is
  'Recomputes mastery from the event set. Correct under out-of-order and duplicate delivery. '
  'Must agree with app/domain/mastery.py::compute_status - there is a test for that.';

-- ---------------------------------------------------------------------------
-- Trigger.
--
-- Row-level for simplicity and correctness. A twenty-event batch therefore recomputes up to
-- twenty times; if that ever shows up in a profile, the change is a statement-level trigger
-- with a transition table recomputing once per distinct (user, concept). Not before evidence.
--
-- Note the filter on `type`: only answers and views can change mastery. Nothing else should
-- cause the recomputation to run, and nothing else may be allowed to.
-- ---------------------------------------------------------------------------
create or replace function private.on_learning_event_inserted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.concept_id is not null
     and new.type in ('quiz_answered', 'concept_viewed') then
    perform private.recompute_concept_mastery(new.user_id, new.lesson_id, new.concept_id);
  end if;
  return null;
end
$$;

create or replace trigger learning_events_update_mastery
  after insert on public.learning_events
  for each row execute function private.on_learning_event_inserted();

revoke all on function private.recompute_concept_mastery(uuid, uuid, text) from public;
revoke all on function private.on_learning_event_inserted() from public;
