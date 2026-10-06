"""Lesson persistence.

Visibility is decided by row-level security, not by the queries here. A learner selecting a
lesson they are not entitled to gets no row, which is why "not found" and "not permitted"
produce the same answer at the API: a distinct error would confirm the lesson exists to
someone who may not see it, turning an id guess into an enumeration oracle.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import orjson

from app.db.types import RlsConnection
from app.ingestion.stages import Stage
from app.schemas.knowledge_graph import DraftKnowledgeGraph, KnowledgeGraph


@dataclass(frozen=True, slots=True)
class LessonRow:
    id: UUID
    owner_id: UUID
    title: str
    status: str
    source_type: str | None
    source_path: str | None
    graph_version: int
    created_at: datetime
    updated_at: datetime

    @property
    def is_published(self) -> bool:
        return self.status == "published"


@dataclass(frozen=True, slots=True)
class JobRow:
    id: UUID
    lesson_id: UUID
    stage: Stage
    failed_stage: Stage | None
    progress: float
    error: str | None
    attempt: int
    warnings: list[str]
    tokens_in: int
    tokens_out: int
    cost_usd: float


def _lesson(row: Any) -> LessonRow:
    return LessonRow(
        id=row["id"],
        owner_id=row["owner_id"],
        title=row["title"],
        status=row["status"],
        source_type=row["source_type"],
        source_path=row["source_path"],
        graph_version=row["graph_version"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def create_lesson(
    connection: RlsConnection, *, owner_id: UUID, title: str
) -> LessonRow:
    row = await connection.fetchrow(
        """
        insert into public.lessons (owner_id, title, status)
        values ($1, $2, 'uploading')
        returning id, owner_id, title, status, source_type, source_path,
               graph_version, created_at, updated_at
        """,
        owner_id,
        title.strip() or "Untitled lesson",
    )
    assert row is not None
    return _lesson(row)


async def get_lesson(connection: RlsConnection, lesson_id: UUID) -> LessonRow | None:
    """A lesson the caller may see, or None.

    None covers both "no such lesson" and "exists but not visible to you", because row-level
    security returns no row in either case. That is the desired behaviour, not a limitation.
    """
    row = await connection.fetchrow(
        """
        select id, owner_id, title, status, source_type, source_path,
               graph_version, created_at, updated_at
        from public.lessons
        where id = $1
        """,
        lesson_id,
    )
    return None if row is None else _lesson(row)


async def list_own_lessons(
    connection: RlsConnection, *, owner_id: UUID, limit: int = 50, before: datetime | None = None
) -> list[LessonRow]:
    """Keyset pagination rather than OFFSET, so deep pages stay cheap (brief section 55)."""
    rows = await connection.fetch(
        """
        select id, owner_id, title, status, source_type, source_path,
               graph_version, created_at, updated_at
        from public.lessons
        where owner_id = $1 and ($2::timestamptz is null or created_at < $2)
        order by created_at desc
        limit $3
        """,
        owner_id,
        before,
        min(limit, 100),
    )
    return [_lesson(row) for row in rows]


async def set_source(
    connection: RlsConnection,
    *,
    lesson_id: UUID,
    source_type: str,
    source_path: str,
) -> None:
    await connection.execute(
        """
        update public.lessons
           set source_type = $2::public.source_type, source_path = $3, status = 'uploading'
         where id = $1
        """,
        lesson_id,
        source_type,
        source_path,
    )


async def get_graph(
    connection: RlsConnection, lesson_id: UUID
) -> DraftKnowledgeGraph | None:
    row = await connection.fetchrow(
        "select graph from public.lessons where id = $1", lesson_id
    )
    if row is None or row["graph"] is None:
        return None
    return DraftKnowledgeGraph.model_validate(row["graph"])


async def save_draft_graph(
    connection: RlsConnection, *, lesson_id: UUID, graph: DraftKnowledgeGraph
) -> None:
    """Store review edits. Does not publish, and does not touch the graph version."""
    await connection.execute(
        """
        update public.lessons
           set graph = $2::jsonb,
               title = coalesce(nullif($3, ''), title)
         where id = $1
        """,
        lesson_id,
        orjson.dumps(graph.model_dump(mode="json", by_alias=True)).decode(),
        graph.title,
    )


@dataclass(frozen=True, slots=True)
class PublishResult:
    graph_version: int
    concepts_upserted: int
    quiz_upserted: int
    concepts_retired: int
    quiz_retired: int


async def publish(
    connection: RlsConnection, *, lesson_id: UUID, graph: KnowledgeGraph
) -> PublishResult:
    """Publish atomically, through the database function.

    One round trip into `publish_lesson`, not five statements orchestrated here. Bumping the
    version, upserting concepts and quiz items, retiring removed ids and flipping the status
    must happen together or not at all; done from Python, a disconnect or a restart could land
    between any two of them and leave a published lesson with the wrong content.
    """
    row = await connection.fetchrow(
        "select * from public.publish_lesson($1, $2::jsonb)",
        lesson_id,
        orjson.dumps(graph.model_dump(mode="json", by_alias=True)).decode(),
    )
    assert row is not None
    return PublishResult(
        graph_version=int(row["graph_version"]),
        concepts_upserted=int(row["concepts_upserted"]),
        quiz_upserted=int(row["quiz_upserted"]),
        concepts_retired=int(row["concepts_retired"]),
        quiz_retired=int(row["quiz_retired"]),
    )


# ---------------------------------------------------------------------------
# Ingestion jobs
# ---------------------------------------------------------------------------
def _job(row: Any) -> JobRow:
    warnings = row["warnings"]
    if isinstance(warnings, str):
        warnings = orjson.loads(warnings)
    return JobRow(
        id=row["id"],
        lesson_id=row["lesson_id"],
        stage=Stage(row["stage"]),
        failed_stage=Stage(row["failed_stage"]) if row["failed_stage"] else None,
        progress=float(row["progress"]),
        error=row["error"],
        attempt=int(row["attempt"]),
        warnings=list(warnings or []),
        tokens_in=int(row["tokens_in"]),
        tokens_out=int(row["tokens_out"]),
        cost_usd=float(row["cost_usd"]),
    )


async def get_active_job(connection: RlsConnection, lesson_id: UUID) -> JobRow | None:
    row = await connection.fetchrow(
        """
        select id, lesson_id, stage, failed_stage, progress, error, attempt,
               warnings, tokens_in, tokens_out, cost_usd
          from public.ingestion_jobs
        where lesson_id = $1
        order by created_at desc
        limit 1
        """,
        lesson_id,
    )
    return None if row is None else _job(row)


async def create_job(connection: RlsConnection, lesson_id: UUID) -> JobRow:
    """Start a job.

    The partial unique index on `ingestion_jobs` refuses a second live job for the same
    lesson, so a double-clicked Ingest is stopped by the database rather than by a check that
    races with itself.
    """
    row = await connection.fetchrow(
        """
        insert into public.ingestion_jobs (lesson_id, stage, started_at)
        values ($1, 'pending', now())
        returning id, lesson_id, stage, failed_stage, progress, error, attempt,
               warnings, tokens_in, tokens_out, cost_usd
        """,
        lesson_id,
    )
    assert row is not None
    return _job(row)


async def advance_job(
    connection: RlsConnection, *, job_id: UUID, stage: Stage, progress: float
) -> None:
    await connection.execute(
        """
        update public.ingestion_jobs
           set stage = $2::public.ingestion_stage,
               progress = $3,
               failed_stage = null,
               error = null
         where id = $1
        """,
        job_id,
        stage.value,
        max(0.0, min(1.0, progress)),
    )


async def fail_job(
    connection: RlsConnection, *, job_id: UUID, stage: Stage, error: str
) -> None:
    """Record where a job failed, so resuming re-enters that stage rather than guessing."""
    await connection.execute(
        """
        update public.ingestion_jobs
           set stage = 'failed',
               failed_stage = $2::public.ingestion_stage,
               error = $3,
               attempt = attempt + 1
         where id = $1
        """,
        job_id,
        stage.value,
        error[:2000],
    )


async def record_job_usage(
    connection: RlsConnection, *, job_id: UUID, tokens_in: int, tokens_out: int, cost_usd: float
) -> None:
    await connection.execute(
        """
        update public.ingestion_jobs
           set tokens_in = tokens_in + $2,
               tokens_out = tokens_out + $3,
               cost_usd = cost_usd + $4
         where id = $1
        """,
        job_id,
        tokens_in,
        tokens_out,
        cost_usd,
    )


async def set_job_warnings(
    connection: RlsConnection, *, job_id: UUID, warnings: list[str]
) -> None:
    await connection.execute(
        "update public.ingestion_jobs set warnings = $2::jsonb where id = $1",
        job_id,
        orjson.dumps(warnings).decode(),
    )


async def set_lesson_status(
    connection: RlsConnection, *, lesson_id: UUID, status: str
) -> None:
    await connection.execute(
        "update public.lessons set status = $2::public.lesson_status where id = $1",
        lesson_id,
        status,
    )
