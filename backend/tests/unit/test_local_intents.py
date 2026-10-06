"""The local intent matcher (PRD task P3-14, 5.4B, 6.2).

PRD P3-14 requires at least three phrasings for each of next, repeat, simplify, quiz_me,
pause and where_am_i. Each of those has considerably more here, because the cost of a missed
match is a model call and the cost of a wrong match is sending a learner somewhere they did
not ask to go.
"""

from __future__ import annotations

import pytest

from app.ai.intents.local import match_local_intent, normalise_utterance

PHRASINGS: dict[str, list[str]] = {
    "next": ["next", "go on", "continue", "keep going", "next concept", "what's next"],
    "previous": ["back", "go back", "previous", "the one before"],
    "repeat": ["repeat", "again", "say that again", "one more time", "I missed that"],
    "simplify": [
        "simpler", "make it easier", "explain that more simply", "in simpler terms",
        "I don't understand",
    ],
    "elaborate": ["elaborate", "tell me more", "go deeper", "more detail"],
    "example": ["example", "give me an example", "show me an example"],
    "quiz_me": ["quiz me", "test me", "ask me a question", "check my understanding"],
    "pause": ["pause", "hold on", "wait", "give me a second"],
    "resume": ["resume", "unpause", "I'm back", "ready"],
    "where_am_i": ["where am I", "where was I", "how far am I", "which section am I on"],
}


class TestRecognisedCommands:
    @pytest.mark.parametrize(
        ("expected", "utterance"),
        [(intent, phrase) for intent, phrases in PHRASINGS.items() for phrase in phrases],
    )
    def test_each_phrasing_maps_to_its_intent(self, expected: str, utterance: str) -> None:
        intent = match_local_intent(utterance)
        assert intent is not None, f"{utterance!r} was not recognised"
        assert intent.type == expected

    @pytest.mark.parametrize(
        "intent_type", ["next", "repeat", "simplify", "quiz_me", "pause", "where_am_i"]
    )
    def test_the_prd_required_intents_have_at_least_three_phrasings(
        self, intent_type: str
    ) -> None:
        assert len(PHRASINGS[intent_type]) >= 3

    def test_speech_rate_commands_carry_a_direction(self) -> None:
        slower = match_local_intent("slow down")
        faster = match_local_intent("speed up")
        assert slower is not None and slower.direction == "slower"  # type: ignore[union-attr]
        assert faster is not None and faster.direction == "faster"  # type: ignore[union-attr]


class TestTranscriptNoise:
    @pytest.mark.parametrize(
        "utterance",
        ["Next.", "NEXT", "  next  ", "um, next", "okay, next please", "uh next"],
    )
    def test_filler_punctuation_and_case_do_not_prevent_a_match(
        self, utterance: str
    ) -> None:
        """Speech transcripts arrive with all of this."""
        intent = match_local_intent(utterance)
        assert intent is not None and intent.type == "next"

    def test_normalisation_is_stable(self) -> None:
        assert normalise_utterance("  Um, NEXT please!! ") == "next"


class TestFallingBackToTheModel:
    @pytest.mark.parametrize(
        "utterance",
        [
            "can you go over that again but easier",
            "why does the water rise",
            "I'd like to change how this looks",
            "take me to the section about clouds",
            "",
            "   ",
        ],
    )
    def test_unmatched_utterances_return_none(self, utterance: str) -> None:
        """None means "ask the model". Returning `unknown` here would skip the fallback and
        tell a learner their perfectly clear request was not understood."""
        assert match_local_intent(utterance) is None


class TestFalsePositives:
    """A missed match costs one model call. A wrong match moves a learner mid-lesson."""

    @pytest.mark.parametrize(
        "utterance",
        [
            "I am not ready for the next part",
            "the next section looked confusing",
            "what happens after you pause evaporation",
            "tell me about the back pressure",
            "does it repeat forever",
            "where am I supposed to find the diagram",
        ],
    )
    def test_a_command_word_inside_a_sentence_does_not_match(self, utterance: str) -> None:
        assert match_local_intent(utterance) is None

    def test_a_question_about_the_lesson_is_not_a_command(self) -> None:
        assert match_local_intent("why do clouds form when vapour cools") is None


class TestQuizAnswers:
    def test_a_letter_is_an_answer_only_while_a_quiz_is_on_screen(self) -> None:
        """Without context, "B" is a letter. With a question on screen it is an answer, and
        deciding from context is what keeps an unrelated utterance out of a learner's
        mastery record."""
        assert match_local_intent("B", quiz_active=False) is None

        answered = match_local_intent("B", quiz_active=True)
        assert answered is not None and answered.type == "answer"
        assert answered.value == "B"  # type: ignore[union-attr]

    @pytest.mark.parametrize("utterance", ["b", "option B", "the answer is c"])
    def test_letter_answers_are_recognised_in_several_forms(self, utterance: str) -> None:
        intent = match_local_intent(utterance, quiz_active=True)
        assert intent is not None and intent.type == "answer"

    @pytest.mark.parametrize("utterance", ["true", "false", "yes", "no"])
    def test_true_false_answers_are_recognised(self, utterance: str) -> None:
        intent = match_local_intent(utterance, quiz_active=True)
        assert intent is not None and intent.type == "answer"

    def test_a_command_still_wins_over_an_answer_during_a_quiz(self) -> None:
        """A learner saying "repeat" during a question wants the question repeated, not to
        submit "repeat" as their answer."""
        intent = match_local_intent("repeat", quiz_active=True)
        assert intent is not None and intent.type == "repeat"


class TestPerformance:
    def test_matching_is_fast_enough_for_the_budget(self) -> None:
        """PRD 6.1 budgets 50 ms for a local intent. This runs server-side as part of a
        request, so the matcher itself must be a rounding error within that."""
        import time

        utterances = [*(p for phrases in PHRASINGS.values() for p in phrases), "unmatched"]
        started = time.perf_counter()
        for _ in range(100):
            for utterance in utterances:
                match_local_intent(utterance)
        elapsed_ms = (time.perf_counter() - started) * 1000

        per_call_ms = elapsed_ms / (100 * len(utterances))
        assert per_call_ms < 1.0, f"{per_call_ms:.3f} ms per match"
