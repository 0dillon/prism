"""Learning Event contract. Transcribed field-for-field from PRD section 5.7.

One event model for every renderer. A learner who completes a lesson by voice, by swiping
cards, by reading, or by watching sign clips produces the same event types against the same
concept ids, which is what makes their progress comparable (PRD CE-10). A renderer must not
keep private progress state (PRD 0.2).

Three properties are load-bearing and easy to erode:

* `id` is a **client-generated ULID** and is the idempotency key. Delivery is at-least-once,
  so the server inserts with conflict-ignore semantics and a replayed batch creates nothing.
* `graph_version` is recorded on every event, so a republished lesson never retroactively
  changes what an old event meant (PRD 5.2, brief section 33).
* `layout` is **product analytics only**. It is never exposed in a teacher or principal view
  except through the suppressed aggregate in B2B-4, because the interface a learner chooses
  can reveal a disability (PRD 5.7, 6.4, decision log).

Note what is absent: there is no `user_id` on the inbound model. The authenticated principal
is stamped by the server and enforced again by row-level security, so a client cannot write
events as another learner.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Final, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.schemas.render_profile import Layout

EventType = Literal[
    "lesson_started",
    "concept_viewed",
    "concept_variant_requested",
    "quiz_presented",
    "quiz_answered",
    "question_asked",
    "session_paused",
    "session_resumed",
    "lesson_completed",
    "profile_changed",
]

# PRD 5.7: active time is the sum of durationMs capped at 60 seconds per event, which excludes
# a learner who left the tab open over lunch from appearing as an hour of engagement.
MAX_EVENT_DURATION_MS: Final = 60_000

# Batch ceiling for POST /api/events. The client flushes every 5 seconds and on page hide, so a
# batch this large only occurs after a long offline stretch.
MAX_EVENT_BATCH_SIZE: Final = 500


class EventModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class LearningEvent(EventModel):
    """A single thing a learner did, identical in shape across all renderers."""

    id: str = Field(
        min_length=1,
        max_length=64,
        description="Client-generated ULID. The idempotency key for this event.",
    )
    lesson_id: str
    graph_version: int = Field(ge=1)
    type: EventType
    concept_id: str | None = None
    quiz_item_id: str | None = None
    correct: bool | None = Field(default=None, description="quiz_answered only.")
    duration_ms: Annotated[int, Field(ge=0)] | None = Field(
        default=None, description="Active time attributed to this event."
    )
    layout: Layout = Field(description="Product analytics only. Never shown per learner.")
    occurred_at: datetime

    def capped_duration_ms(self) -> int:
        """Duration clamped to the PRD's 60 second ceiling, for engagement arithmetic."""
        if self.duration_ms is None:
            return 0
        return min(self.duration_ms, MAX_EVENT_DURATION_MS)


class LearningEventBatch(EventModel):
    """The POST /api/events payload.

    Carries no user identity: the server stamps the authenticated principal on every row.
    """

    events: Annotated[
        list[LearningEvent], Field(min_length=1, max_length=MAX_EVENT_BATCH_SIZE)
    ]


class EventIngestResult(EventModel):
    """What the server did with a batch.

    `duplicates` lets a client confirm that a retry was recognised as a retry rather than
    silently creating a second row.
    """

    received: int
    inserted: int
    duplicates: int
