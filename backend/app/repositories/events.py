"""Learning event persistence (PRD 5.7, task P5-02).

The hottest write path in the product, and the one with the strongest correctness
requirements. Three properties are enforced here and again by the database:

**The user is stamped server-side.** `identity.user_id` is written onto every row. The inbound
model has no user field at all, and the RLS `WITH CHECK` rejects any other value, so there are
two independent layers between a client and someone else's progress record.

**Inserts are idempotent.** `id` is the client-generated ULID and the primary key, and the
insert ignores conflicts. Delivery is at-least-once by design (PRD 6.5: the client queue
persists unsent events and retries with backoff), so a replayed batch must create nothing.

**Duration is capped at insert.** PRD 5.7 caps active time at 60 seconds per event to exclude
idle time. Capping at write rather than at read means every reader gets it right, including
ones written later by someone who has not read that line of the PRD.
"""

from __future__ import annotations

from uuid import UUID

from app.db.types import RlsConnection
from app.schemas.events import MAX_EVENT_DURATION_MS, EventIngestResult, LearningEvent

_INSERT_SQL = """
insert into public.learning_events (
  id, user_id, lesson_id, graph_version, type,
  concept_id, quiz_item_id, correct, duration_ms, layout, occurred_at
)
values ($1, $2, $3, $4, $5::public.learning_event_type,
        $6, $7, $8, $9, $10::public.renderer_layout, $11)
on conflict (id) do nothing
"""


async def insert_events(
    connection: RlsConnection, *, user_id: UUID, events: list[LearningEvent]
) -> EventIngestResult:
    """Insert a batch, ignoring events already recorded.

    Returns how many were new so a client can confirm its retry was recognised as a retry
    rather than silently creating a second row.
    """
    if not events:
        return EventIngestResult(received=0, inserted=0, duplicates=0)

    before = await _count_existing(connection, [event.id for event in events])

    rows = [
        (
            event.id,
            user_id,
            UUID(event.lesson_id),
            event.graph_version,
            event.type,
            event.concept_id,
            event.quiz_item_id,
            event.correct,
            None if event.duration_ms is None else min(event.duration_ms, MAX_EVENT_DURATION_MS),
            event.layout,
            event.occurred_at,
        )
        for event in events
    ]

    # executemany pipelines a prepared statement in one round trip, which matters on a path
    # every learner hits every five seconds.
    await connection.executemany(_INSERT_SQL, rows)

    after = await _count_existing(connection, [event.id for event in events])
    inserted = after - before
    return EventIngestResult(
        received=len(events),
        inserted=inserted,
        duplicates=len(events) - inserted,
    )


async def _count_existing(connection: RlsConnection, ids: list[str]) -> int:
    count = await connection.fetchval(
        "select count(*) from public.learning_events where id = any($1::text[])", ids
    )
    return int(count or 0)


async def lesson_progress(
    connection: RlsConnection, *, user_id: UUID, lesson_id: UUID
) -> tuple[int, int]:
    """Mastered concepts and total concepts for a learner on a lesson.

    Aggregated in Postgres rather than by loading rows into Python. PRD 6.1 budgets two
    seconds for a dashboard over a thousand students, and that is not reachable any other way.
    Counting from `concept_mastery` rather than `learning_events` keeps it over hundreds of
    rows instead of hundreds of thousands.
    """
    row = await connection.fetchrow(
        """
        select
          count(*) filter (where cm.status = 'mastered')::int as mastered,
          (select count(*)::int
             from public.concepts c
            where c.lesson_id = $2 and not c.retired)          as total
        from public.concept_mastery cm
        where cm.user_id = $1 and cm.lesson_id = $2
        """,
        user_id,
        lesson_id,
    )
    if row is None:
        return (0, 0)
    return (int(row["mastered"] or 0), int(row["total"] or 0))
