"""Session intent contract. Transcribed from PRD section 5.4B.

An intent is what a learner asked for during a lesson, normalised away from how they said it.
The same `next` intent arrives from a swipe, an arrow key, a spoken "keep going", or a typed
command, and the session reducer treats all four identically. That is what keeps renderers
interchangeable.

PRD 5.4 requires that common commands be matched locally by keyword first, with only unmatched
utterances reaching the LLM. The discriminated union here is the shared output of both paths.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

RateDirection = Literal["slower", "faster"]


class IntentModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class NextIntent(IntentModel):
    type: Literal["next"] = "next"


class PreviousIntent(IntentModel):
    type: Literal["previous"] = "previous"


class RepeatIntent(IntentModel):
    type: Literal["repeat"] = "repeat"


class SimplifyIntent(IntentModel):
    type: Literal["simplify"] = "simplify"


class ElaborateIntent(IntentModel):
    type: Literal["elaborate"] = "elaborate"


class ExampleIntent(IntentModel):
    type: Literal["example"] = "example"


class QuizMeIntent(IntentModel):
    type: Literal["quiz_me"] = "quiz_me"


class AnswerIntent(IntentModel):
    type: Literal["answer"] = "answer"
    value: str


class PauseIntent(IntentModel):
    type: Literal["pause"] = "pause"


class ResumeIntent(IntentModel):
    type: Literal["resume"] = "resume"


class WhereAmIIntent(IntentModel):
    type: Literal["where_am_i"] = "where_am_i"


class GoToIntent(IntentModel):
    type: Literal["go_to"] = "go_to"
    target: str = Field(description="Section or concept title.")


class SetRateIntent(IntentModel):
    type: Literal["set_rate"] = "set_rate"
    direction: RateDirection


class ChangeProfileIntent(IntentModel):
    type: Literal["change_profile"] = "change_profile"
    request: str = Field(description="Forwarded to the needs-to-profile parser.")


class QuestionIntent(IntentModel):
    type: Literal["question"] = "question"
    text: str = Field(description="A free question about the lesson.")


class UnknownIntent(IntentModel):
    """Nothing matched. The renderer asks the learner to rephrase.

    An explicit member rather than a null: "I did not understand" is a real outcome the
    conversation renderer must speak, not an error to swallow.
    """

    type: Literal["unknown"] = "unknown"


SessionIntent = Annotated[
    NextIntent
    | PreviousIntent
    | RepeatIntent
    | SimplifyIntent
    | ElaborateIntent
    | ExampleIntent
    | QuizMeIntent
    | AnswerIntent
    | PauseIntent
    | ResumeIntent
    | WhereAmIIntent
    | GoToIntent
    | SetRateIntent
    | ChangeProfileIntent
    | QuestionIntent
    | UnknownIntent,
    Field(discriminator="type"),
]

# The intent types that carry no payload, which is what the local keyword matcher can produce
# on its own without extracting any arguments.
SIMPLE_INTENT_TYPES: tuple[str, ...] = (
    "next",
    "previous",
    "repeat",
    "simplify",
    "elaborate",
    "example",
    "quiz_me",
    "pause",
    "resume",
    "where_am_i",
)


class SessionIntentEnvelope(IntentModel):
    """Wrapper used where a bare union cannot be the top-level schema.

    Needed in two places: OpenAPI response models, and strict LLM structured output, whose
    JSON Schema root must be an object rather than a union.
    """

    intent: SessionIntent
