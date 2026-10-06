"""In-session commands, grading, and speech (PRD 5.4B, 5.6.3, 6.6).

    POST /api/session/intent
    POST /api/tutor/grade
    POST /api/speech/stt
    POST /api/speech/tts
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.ai.intents.session import MAX_UTTERANCE_CHARACTERS, SessionIntentResolver
from app.ai.tutor.grade import MAX_ANSWER_CHARACTERS, AnswerGrader
from app.ai.types import UsageContext
from app.api.dependencies import (
    AppSettings,
    CurrentUser,
    Db,
    Gateway,
    Limiter,
    enforce_rate_limit,
)
from app.api.errors import ErrorCode, ErrorResponse, NotFoundError
from app.repositories import lessons as lessons_repo
from app.schemas.intents import SessionIntent
from app.speech.interfaces import SpeechUnavailableError

router = APIRouter(tags=["session"])


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


# ---------------------------------------------------------------------------
class IntentRequest(ApiModel):
    utterance: Annotated[str, Field(max_length=MAX_UTTERANCE_CHARACTERS)]
    lesson_id: str | None = None
    current_concept: str | None = Field(
        default=None, description="Title of the concept on screen, for disambiguation."
    )
    quiz_active: bool = Field(
        default=False,
        description=(
            "Whether a question is on screen. With one, a bare letter is an answer; without "
            "one it is just a letter."
        ),
    )


class IntentResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    intent: SessionIntent
    source: str = Field(
        description=(
            "'local' when matched by keyword, 'model' when interpreted, 'degraded' when the "
            "model was unreachable."
        )
    )


@router.post(
    "/session/intent",
    response_model=IntentResponse,
    summary="Interpret an in-session command",
    description=(
        "Turns what a learner said into a `SessionIntent`.\n\n"
        "Common commands are matched locally by keyword and never reach a model, which is "
        "both a cost control (PRD 6.2) and a latency requirement (PRD 6.1 budgets 50 ms for "
        "the local path against 800 ms at p90 for the model path). Only unmatched utterances "
        "are interpreted.\n\n"
        "If the model is unreachable the response is the `unknown` intent with "
        "`source: degraded` - locally matched commands keep working, per PRD 6.5."
    ),
    responses={429: {"model": ErrorResponse, "description": "Rate limited"}},
)
async def resolve_intent(
    payload: IntentRequest,
    request: Request,
    user: CurrentUser,
    gateway: Gateway,
    limiter: Limiter,
) -> IntentResponse:
    await enforce_rate_limit(
        request=request, operation="session.intent", identity=user, limiter=limiter
    )

    resolution = await SessionIntentResolver(gateway).resolve(
        utterance=payload.utterance,
        quiz_active=payload.quiz_active,
        current_concept=payload.current_concept,
        context=UsageContext(operation="session.intent", user_id=user.user_id),
    )
    return IntentResponse(intent=resolution.intent, source=resolution.source)


# ---------------------------------------------------------------------------
class GradeRequest(ApiModel):
    lesson_id: str
    quiz_item_id: str
    answer: Annotated[str, Field(max_length=MAX_ANSWER_CHARACTERS)]


class GradeResponse(ApiModel):
    correct: bool
    feedback: str
    graded_by: str = Field(
        description="'local' when graded by comparison, 'model' when judged, "
        "'unavailable' when grading could not run."
    )


@router.post(
    "/tutor/grade",
    response_model=GradeResponse,
    summary="Grade a short answer",
    description=(
        "Grades one answer against the lesson's quiz item.\n\n"
        "Multiple choice and true/false are graded by comparison with no model call "
        "(PRD 6.2), as are short answers that match the model answer or an accepted "
        "alternative exactly. Only genuine judgement calls reach a model.\n\n"
        "If grading is unavailable the answer is **not** marked wrong: the response explains "
        "that it could not be checked, because marking a correct answer wrong would cost the "
        "learner mastery they earned."
    ),
    responses={
        404: {"model": ErrorResponse, "description": "No such question, or not visible to you"},
        429: {"model": ErrorResponse, "description": "Rate limited"},
    },
)
async def grade_answer(
    payload: GradeRequest,
    request: Request,
    user: CurrentUser,
    db: Db,
    gateway: Gateway,
    limiter: Limiter,
) -> GradeResponse:
    await enforce_rate_limit(
        request=request, operation="tutor.grade", identity=user, limiter=limiter
    )

    from uuid import UUID

    graph = await lessons_repo.get_graph(db, UUID(payload.lesson_id))
    if graph is None:
        # Indistinguishable from "not entitled", deliberately: see app/api/errors.py.
        raise NotFoundError("That lesson is not available.", code=ErrorCode.LESSON_NOT_FOUND)

    item = next((q for q in graph.quiz_items if q.id == payload.quiz_item_id), None)
    if item is None:
        raise NotFoundError("That question is not in this lesson.")

    result = await AnswerGrader(gateway).grade(
        item=item,
        learner_answer=payload.answer,
        context=UsageContext(operation="tutor.grade", user_id=user.user_id),
    )
    return GradeResponse(
        correct=result.correct, feedback=result.feedback, graded_by=result.source
    )


# ---------------------------------------------------------------------------
class SpeechModeResponse(ApiModel):
    """What the client should do, when speech is handled on the device."""

    mode: str
    fallback: str
    message: str


def _browser_mode_response(message: str) -> dict[str, Any]:
    """An actionable answer rather than a 500 (PRD 6.5, brief section 39).

    The endpoint exists in both configurations so the client contract is stable; in browser
    mode it tells the renderer to use the device's own speech, which is an instruction it can
    act on.
    """
    return {
        "error": {
            "code": ErrorCode.SPEECH_PROVIDER_BROWSER.value,
            "message": message,
            "details": {"fallback": "browser"},
        }
    }


@router.post(
    "/speech/stt",
    summary="Transcribe speech",
    status_code=status.HTTP_200_OK,
    description=(
        "Transcribes audio to text.\n\n"
        "When `STT_PROVIDER` is `browser` (the MVP configuration) this returns "
        "`SPEECH_PROVIDER_BROWSER`, telling the client to use the device's own speech "
        "recognition. **Audio is never stored** (PRD 6.4): it is processed in memory and only "
        "the resulting text is kept.\n\n"
        "If speech fails, the conversation renderer falls back to text input and the on-screen "
        "transcript (PRD CE-6, 6.5)."
    ),
)
async def speech_to_text(
    request: Request, user: CurrentUser, limiter: Limiter, settings: AppSettings
) -> Any:
    await enforce_rate_limit(
        request=request, operation="speech.stt", identity=user, limiter=limiter
    )
    if settings.stt_provider == "browser":
        return _browser_mode_response(
            "Speech recognition runs in your browser in this configuration."
        )
    raise SpeechUnavailableError("No server-side speech provider is configured.")


@router.post(
    "/speech/tts",
    summary="Synthesise speech",
    status_code=status.HTTP_200_OK,
    description=(
        "Synthesises audio from text.\n\n"
        "When `TTS_PROVIDER` is `browser` (the MVP configuration) this returns "
        "`SPEECH_PROVIDER_BROWSER`, telling the client to use the device's own speech "
        "synthesis. Production audio is cached per (text hash, voice, rate) per PRD 6.2."
    ),
)
async def text_to_speech(
    request: Request, user: CurrentUser, limiter: Limiter, settings: AppSettings
) -> Any:
    await enforce_rate_limit(
        request=request, operation="speech.tts", identity=user, limiter=limiter
    )
    if settings.tts_provider == "browser":
        return _browser_mode_response(
            "Speech synthesis runs in your browser in this configuration."
        )
    raise SpeechUnavailableError("No server-side speech provider is configured.")
