"""Answer grading (PRD 5.6.3, 6.2, task P4-19).

Multiple choice and true/false are graded **locally, with no model call**. PRD 6.2 requires
it, and it is also the better answer on every other axis: string comparison is instant, free,
deterministic, and keeps working when the provider is down (PRD 6.5). Only short answers need
a model, because only short answers need judgement.

Grading never trusts the model's output as application state without validating it first. A
grade feeds `quiz_answered`, which feeds mastery, which is what a teacher sees; a malformed
response must not become a learner's record.

Open question carried from PRD 9.3: whether model grading is acceptable for graded school
assessment, or should be limited to practice. Nothing here assumes an answer. The structure
keeps the choice open, because local grading and model grading return the same type.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from app.ai.errors import LlmError
from app.ai.gateway import LlmGateway
from app.ai.prompts.session import GRADE_SYSTEM, build_grade_user_turn
from app.ai.schemas import GradeOut
from app.ai.types import Prompt, UsageContext
from app.core.logging import get_logger
from app.schemas.knowledge_graph import QuizItem

logger = get_logger(__name__)

MAX_ANSWER_CHARACTERS = 2000

GradeSource = Literal["local", "model", "unavailable"]

_PUNCTUATION = re.compile(r"[^\w\s]")
_WHITESPACE = re.compile(r"\s+")

# Letter answers from the conversation renderer: spoken quizzes read options as A, B, C.
_LETTER = re.compile(r"\A(?:option\s+|answer\s+)?([a-z])\Z")

_AFFIRMATIVE = {"true", "yes", "correct", "right", "t"}
_NEGATIVE = {"false", "no", "incorrect", "wrong", "f"}


@dataclass(frozen=True, slots=True)
class GradeResult:
    correct: bool
    feedback: str
    source: GradeSource


def normalise_answer(text: str) -> str:
    folded = unicodedata.normalize("NFKC", text).strip().casefold()
    folded = _PUNCTUATION.sub(" ", folded)
    return _WHITESPACE.sub(" ", folded).strip()


def grade_locally(item: QuizItem, learner_answer: str) -> GradeResult | None:
    """Grade without a model, or return None when the item needs judgement."""
    answer = normalise_answer(learner_answer)
    if not answer:
        return GradeResult(
            correct=False, feedback="I didn't catch an answer there.", source="local"
        )

    if item.type == "true_false":
        expected = normalise_answer(item.answer)
        if answer in _AFFIRMATIVE:
            given = "true"
        elif answer in _NEGATIVE:
            given = "false"
        else:
            return GradeResult(
                correct=False,
                feedback=f"That one is true or false. {item.explanation}",
                source="local",
            )
        return _result(given == expected, item)

    if item.type == "mcq" and item.options:
        chosen = _resolve_choice(answer, item.options)
        if chosen is None:
            options = ", ".join(item.options)
            return GradeResult(
                correct=False,
                feedback=f"I couldn't match that to an option. The choices are: {options}.",
                source="local",
            )
        return _result(chosen == item.answer, item)

    # Short answer. An exact match against the model answer or an accepted alternative is
    # still decided locally: it costs nothing and is not a judgement call.
    accepted = {normalise_answer(item.answer)} | {
        normalise_answer(alternative) for alternative in item.acceptable
    }
    if answer in accepted:
        return _result(True, item)
    return None


def _resolve_choice(answer: str, options: list[str]) -> str | None:
    """Match a learner's words to an option, by letter or by content.

    PRD task P4-18: saying "B" and saying the option's text must register the same answer.
    """
    for option in options:
        if normalise_answer(option) == answer:
            return option

    if (letter := _LETTER.match(answer)) is not None:
        index = ord(letter.group(1)) - ord("a")
        if 0 <= index < len(options):
            return options[index]
    return None


def _result(correct: bool, item: QuizItem) -> GradeResult:
    return GradeResult(
        correct=correct,
        feedback=item.explanation if item.explanation else ("Correct." if correct else ""),
        source="local",
    )


class AnswerGrader:
    """Grades locally where possible, and asks the fast model only when judgement is needed."""

    def __init__(self, gateway: LlmGateway) -> None:
        self._gateway = gateway

    async def grade(
        self,
        *,
        item: QuizItem,
        learner_answer: str,
        context: UsageContext | None = None,
    ) -> GradeResult:
        answer = learner_answer[:MAX_ANSWER_CHARACTERS]

        local = grade_locally(item, answer)
        if local is not None:
            return local

        prompt = Prompt(
            system=GRADE_SYSTEM,
            user=build_grade_user_turn(
                question=item.prompt,
                model_answer=item.answer,
                acceptable=item.acceptable,
                learner_answer=answer,
            ),
        )

        try:
            result = await self._gateway.generate_structured(
                schema=GradeOut,
                prompt=prompt,
                tier="fast",
                operation="tutor.grade",
                context=context or UsageContext(operation="tutor.grade"),
                max_output_tokens=300,
            )
        except LlmError as exc:
            # Degrading to "wrong" would record an answer the learner may well have got
            # right, and under the mastery rule that costs them progress they earned. The
            # renderer shows the explanation and does not record a grade.
            logger.warning("grading_unavailable", extra={"failure": type(exc).__name__})
            return GradeResult(
                correct=False,
                feedback=(
                    "I can't check that answer right now. Here is the explanation: "
                    f"{item.explanation}"
                ),
                source="unavailable",
            )

        graded: GradeOut = result.value
        return GradeResult(
            correct=graded.correct,
            feedback=graded.feedback.strip() or item.explanation,
            source="model",
        )
