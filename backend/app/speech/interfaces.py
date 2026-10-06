"""Speech provider interfaces (PRD 7.2, 6.6, task P4-14, brief section 39).

The MVP path is browser speech, and production is a server-side provider. Both sit behind
these interfaces so the conversation renderer never learns which is in use, and so moving from
one to the other is a configuration change rather than a rewrite.

Two rules are absolute and are enforced here rather than left to a provider:

**Voice audio is never stored.** PRD 6.4: audio is processed in memory, and only the resulting
text is kept. No type in this module has a field for audio bytes that outlive a request, and
the transcript result carries text alone.

**Speech failure degrades, it does not break.** PRD 6.5 and CE-6: if speech fails, the
conversation renderer falls back to text input and the on-screen transcript. So a failure here
produces a structured, actionable result rather than an exception that becomes a 500 - the
renderer needs to be told *what to do instead*, not that something went wrong.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

SpeechMode = Literal["browser", "server"]


class SpeechUnavailableError(Exception):
    """A speech provider could not serve this request.

    Carries what the client should do instead, because "fall back to text" is a product
    behaviour the renderer has to implement, not an error to display.
    """

    def __init__(self, message: str, *, fallback: str = "text") -> None:
        super().__init__(message)
        self.fallback = fallback


@dataclass(frozen=True, slots=True)
class WordTiming:
    """Word-level timing, for synchronised highlighting (PRD 5.6.2, task P4-12)."""

    word: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True, slots=True)
class Transcript:
    """The text of what was said. Deliberately carries no audio."""

    text: str
    confidence: float | None = None
    words: list[WordTiming] = field(default_factory=list)
    is_final: bool = True


@dataclass(frozen=True, slots=True)
class SpeechAudio:
    """Synthesised audio, as a reference rather than as bytes.

    A URL rather than inline data so the response stays small, the audio can be cached per
    PRD 6.2, and a client can stream it rather than waiting for the whole clip.
    """

    url: str
    duration_ms: int | None = None
    words: list[WordTiming] = field(default_factory=list)
    cached: bool = False


class SttProvider(Protocol):
    """Speech to text.

    The audio argument is consumed within the call and never persisted.
    """

    name: str
    mode: SpeechMode

    async def transcribe(
        self, audio: bytes, *, content_type: str, language: str = "en"
    ) -> Transcript: ...


class TtsProvider(Protocol):
    """Text to speech."""

    name: str
    mode: SpeechMode

    async def synthesise(
        self, text: str, *, voice: str, rate: float = 1.0
    ) -> SpeechAudio: ...


class BrowserSttProvider:
    """The MVP path: the browser's own Web Speech API does the work.

    Raising rather than pretending is the point. The endpoint exists so the client contract is
    stable across both modes, and in browser mode it answers "do this on the device", which is
    an instruction the renderer can act on.
    """

    name = "browser"
    mode: SpeechMode = "browser"

    async def transcribe(
        self, audio: bytes, *, content_type: str, language: str = "en"
    ) -> Transcript:
        raise SpeechUnavailableError(
            "Speech recognition runs in your browser in this configuration.",
            fallback="browser",
        )


class BrowserTtsProvider:
    """The MVP path: the browser's own speechSynthesis does the work."""

    name = "browser"
    mode: SpeechMode = "browser"

    async def synthesise(self, text: str, *, voice: str, rate: float = 1.0) -> SpeechAudio:
        raise SpeechUnavailableError(
            "Speech synthesis runs in your browser in this configuration.",
            fallback="browser",
        )


def tts_cache_key(*, text: str, voice: str, rate: float) -> str:
    """PRD 6.2: text-to-speech audio is cached per (text hash, voice, rate).

    The rate is rounded, because a slider producing 1.0000001 and 1.0 must not create two
    copies of identical audio.
    """
    import hashlib

    digest = hashlib.sha256(text.strip().encode("utf-8")).hexdigest()
    return f"{digest}:{voice}:{round(rate, 2)}"
