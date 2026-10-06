"""In-session intent resolution (PRD 5.4B, tasks P3-14 and P3-15).

Local keyword matching first, the fast model only on a miss. PRD 6.2 requires that ordering as
a cost control, and PRD 6.1 makes it a latency requirement too: 50 ms for a local match
against 800 ms at the 90th percentile for the model path. In the conversation renderer that
difference is the gap between a tutor that responds and one that lags.

When the model is unreachable, the result is `unknown` rather than an error. PRD 6.5 requires
published lessons to stay usable when the LLM fails, and every command the learner is likely
to need - next, repeat, simplify, quiz me, pause - is matched locally and keeps working.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.ai.adapters import intent_to_union
from app.ai.errors import LlmError
from app.ai.gateway import LlmGateway
from app.ai.intents.local import match_local_intent
from app.ai.prompts.session import (
    SESSION_INTENT_SYSTEM,
    build_session_intent_user_turn,
)
from app.ai.schemas import SessionIntentOut
from app.ai.types import Prompt, UsageContext
from app.core.logging import get_logger
from app.schemas.intents import SessionIntent, UnknownIntent

logger = get_logger(__name__)

# Long enough for a spoken sentence, short enough that the endpoint is not a way to push
# arbitrary text through a model.
MAX_UTTERANCE_CHARACTERS = 500

Source = Literal["local", "model", "degraded"]


@dataclass(frozen=True, slots=True)
class IntentResolution:
    intent: SessionIntent
    source: Source

    @property
    def used_model(self) -> bool:
        return self.source == "model"


class SessionIntentResolver:
    def __init__(self, gateway: LlmGateway) -> None:
        self._gateway = gateway

    async def resolve(
        self,
        *,
        utterance: str,
        quiz_active: bool = False,
        current_concept: str | None = None,
        context: UsageContext | None = None,
    ) -> IntentResolution:
        text = utterance.strip()
        if not text:
            return IntentResolution(intent=UnknownIntent(), source="local")

        local = match_local_intent(text, quiz_active=quiz_active)
        if local is not None:
            return IntentResolution(intent=local, source="local")

        if len(text) > MAX_UTTERANCE_CHARACTERS:
            text = text[:MAX_UTTERANCE_CHARACTERS]

        prompt = Prompt(
            system=SESSION_INTENT_SYSTEM,
            user=build_session_intent_user_turn(
                utterance=text, current_concept=current_concept, quiz_active=quiz_active
            ),
        )

        try:
            result = await self._gateway.generate_structured(
                schema=SessionIntentOut,
                prompt=prompt,
                tier="fast",
                operation="session.intent",
                context=context or UsageContext(operation="session.intent"),
                max_output_tokens=200,
            )
        except LlmError as exc:
            # PRD 6.5: the lesson stays usable. Every command a learner is likely to need was
            # already handled locally; this path is only for the unusual phrasings.
            logger.warning(
                "session_intent_unavailable", extra={"failure": type(exc).__name__}
            )
            return IntentResolution(intent=UnknownIntent(), source="degraded")

        return IntentResolution(intent=intent_to_union(result.value), source="model")
