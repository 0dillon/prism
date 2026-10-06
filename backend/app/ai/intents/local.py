"""Deterministic keyword matching for in-session commands (PRD 5.4B, task P3-14).

PRD 6.2 is explicit: keyword matching before any LLM intent call. That is not only a cost
control. PRD 6.1 budgets 50 ms for a local intent against 800 ms at the 90th percentile for
the model path, and in the conversation renderer that difference is the gap between a tutor
that responds and one that lags. "Next" should never wait on a network round trip.

Returns None when nothing matches, which is the signal to fall back to the model. Returning
`unknown` here instead would skip the fallback and tell a learner their perfectly clear
request was not understood.

Matching deliberately errs towards *not* matching. A false negative costs one model call; a
false positive sends a learner somewhere they did not ask to go, mid-lesson, possibly by
voice. So patterns are anchored to whole utterances rather than searched for anywhere inside
them - "I am not ready for the next part" must not match "next".
"""

from __future__ import annotations

import re
from typing import Final

from app.schemas.intents import (
    AnswerIntent,
    ElaborateIntent,
    ExampleIntent,
    NextIntent,
    PauseIntent,
    PreviousIntent,
    QuizMeIntent,
    RepeatIntent,
    ResumeIntent,
    SessionIntent,
    SetRateIntent,
    SimplifyIntent,
    WhereAmIIntent,
)

# Filler a speech transcript routinely picks up, stripped before matching so "um, next please"
# matches as cleanly as "next".
_FILLER: Final = re.compile(
    r"\b(um|uh|er|erm|like|please|prism|ok|okay|so|well|hey|hmm)\b", re.IGNORECASE
)
_PUNCTUATION: Final = re.compile(r"[^\w\s']")
_WHITESPACE: Final = re.compile(r"\s+")

# Whole-utterance patterns, in priority order. Anchored at both ends on purpose.
_PATTERNS: Final[tuple[tuple[re.Pattern[str], type[SessionIntent]], ...]] = (
    (
        re.compile(
            r"\A(next|go on|continue|carry on|keep going|move on|go ahead|onward|"
            r"next one|next concept|next card|next bit|next part|what's next|whats next|"
            r"go to the next( one| concept| card| bit| part)?)\Z"
        ),
        NextIntent,
    ),
    (
        re.compile(
            r"\A(back|go back|previous|last one|the one before|"
            r"previous (one|concept|card)|go back a bit|back up|undo that)\Z"
        ),
        PreviousIntent,
    ),
    (
        re.compile(
            r"\A(repeat|again|say (that|it) again|one more time|come again|"
            r"repeat (that|it)|can you repeat( that| it)?|i missed that|"
            r"say that one more time|what was that)\Z"
        ),
        RepeatIntent,
    ),
    (
        re.compile(
            r"\A(simpler|simplify|easier|make (it|that) simpler|make (it|that) easier|"
            r"in simpler terms|explain (that|it) more simply|plain english|"
            r"say (that|it) more simply|dumb (it|that) down|too complicated|"
            r"i don't understand|i dont understand)\Z"
        ),
        SimplifyIntent,
    ),
    (
        re.compile(
            r"\A(elaborate|more detail|tell me more|go deeper|expand on (that|it)|"
            r"explain (that|it) more|more about (that|this)|in more depth)\Z"
        ),
        ElaborateIntent,
    ),
    (
        re.compile(
            r"\A(example|give me an example|for example|show me an example|"
            r"can you give an example|an example please|like what)\Z"
        ),
        ExampleIntent,
    ),
    (
        re.compile(
            r"\A(quiz me|test me|quiz|ask me( a question| something)?|"
            r"give me a question|check my understanding|let's practice|lets practice|"
            r"i want a quiz|question me)\Z"
        ),
        QuizMeIntent,
    ),
    (
        re.compile(r"\A(pause|wait|hold on|stop|hang on|give me a (second|minute|moment)|"
                   r"one moment|pause please)\Z"),
        PauseIntent,
    ),
    (
        re.compile(r"\A(resume|continue please|carry on now|unpause|start again|"
                   r"i'm back|im back|ready|go on then)\Z"),
        ResumeIntent,
    ),
    (
        re.compile(
            r"\A(where am i|where was i|what section|which (concept|section) (is this|am i on)|"
            r"how far (am i|have i got)|what are we (on|doing)|remind me where i am|"
            r"how much is left|where are we)\Z"
        ),
        WhereAmIIntent,
    ),
)

_SLOWER: Final = re.compile(r"\A(slower|slow down|too fast|not so fast|speak slower|"
                            r"a bit slower|less speed)\Z")
_FASTER: Final = re.compile(r"\A(faster|speed up|too slow|speak faster|a bit faster|"
                            r"more speed|hurry up)\Z")

# "B" or "option B" when a quiz is on screen. Only consulted when the caller says a quiz is
# active, because a bare "a" is a word, not an answer.
_LETTER_ANSWER: Final = re.compile(r"\A(?:option\s+|answer\s+|the answer is\s+)?([a-d])\Z")
_TRUE_FALSE: Final = re.compile(r"\A(true|false|yes|no)\Z")


def normalise_utterance(utterance: str) -> str:
    """Lowercase, strip filler and punctuation, collapse whitespace."""
    text = utterance.strip().lower()
    text = _FILLER.sub(" ", text)
    text = _PUNCTUATION.sub(" ", text)
    return _WHITESPACE.sub(" ", text).strip()


def match_local_intent(
    utterance: str, *, quiz_active: bool = False
) -> SessionIntent | None:
    """A recognised intent, or None to fall back to the model.

    `quiz_active` matters: with a question on screen "B" is an answer, and without one it is
    a letter. Deciding that from context rather than guessing is what keeps a learner from
    having an unrelated utterance recorded as a quiz answer.
    """
    text = normalise_utterance(utterance)
    if not text:
        return None

    if quiz_active:
        if (letter := _LETTER_ANSWER.match(text)) is not None:
            return AnswerIntent(value=letter.group(1).upper())
        if _TRUE_FALSE.match(text):
            return AnswerIntent(value=text)

    for pattern, intent_class in _PATTERNS:
        if pattern.match(text):
            return intent_class()

    if _SLOWER.match(text):
        return SetRateIntent(direction="slower")
    if _FASTER.match(text):
        return SetRateIntent(direction="faster")

    return None
