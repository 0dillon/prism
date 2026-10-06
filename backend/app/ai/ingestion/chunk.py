"""Chunking (PRD 5.1 step 3, task P2-03).

Split on headings first, then by size with overlap, keeping every chunk's locators. PRD 5.1
specifies about 1,500 tokens with 150 token overlap.

Two properties matter beyond "the text is in pieces".

**Every chunk keeps at least one locator.** A concept extracted from a chunk inherits that
chunk's locator, and PRD CE-1 requires every concept to point back into the source. A chunk
that lost its locator produces concepts a teacher cannot verify.

**Chunk ids are deterministic**, derived from the source hash and the chunk's content. That is
what makes resume work at the chunk level: the map stage stores its output per chunk id, and a
resumed job skips the chunks it has already paid for. Were the ids random, every resume would
re-run the whole stage. It also means that if the chunker itself changes, the ids change, the
stored shards stop matching, and the stage correctly re-runs - which is the right behaviour,
not a bug.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Final

from app.ai.ingestion.extract import LocatorKind, Segment, SourceDocument

# PRD 5.1 says "about 1,500 tokens, 150 token overlap". Tokens are provider-specific, so the
# budget is held in characters at roughly four characters per token: a stable, dependency-free
# approximation that errs slightly small, which is the safe direction for a context limit.
CHARS_PER_TOKEN: Final = 4
DEFAULT_CHUNK_TOKENS: Final = 1500
DEFAULT_OVERLAP_TOKENS: Final = 150

# Below this, a trailing fragment is folded into the previous chunk instead of becoming a
# chunk of its own: a 40-character chunk costs a whole model call to extract nothing.
MIN_CHUNK_CHARS: Final = 200

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


@dataclass(frozen=True, slots=True)
class Chunk:
    """A unit of work for the concept extraction stage."""

    id: str
    text: str
    index: int
    kind: LocatorKind
    start: float
    end: float | None = None
    heading: str | None = None

    @property
    def characters(self) -> int:
        return len(self.text)


@dataclass(slots=True)
class ChunkIndex:
    """The chunk list without the text.

    The map stage loads chunk text one chunk at a time. Holding every chunk's text in memory
    is fine for a 20-page PDF and not fine for the 60-minute audio case in PRD 6.1, so the
    index exists to let the stage iterate without loading the document.
    """

    items: list[Chunk] = field(default_factory=list)
    source_sha256: str = ""

    def __len__(self) -> int:
        return len(self.items)

    def ids(self) -> list[str]:
        return [chunk.id for chunk in self.items]

    def by_id(self, chunk_id: str) -> Chunk | None:
        return next((chunk for chunk in self.items if chunk.id == chunk_id), None)


def chunk_document(
    document: SourceDocument,
    *,
    chunk_tokens: int = DEFAULT_CHUNK_TOKENS,
    overlap_tokens: int = DEFAULT_OVERLAP_TOKENS,
) -> ChunkIndex:
    """Split a source document into overlapping chunks."""
    if chunk_tokens <= 0:
        raise ValueError("chunk_tokens must be positive")
    if not 0 <= overlap_tokens < chunk_tokens:
        raise ValueError("overlap_tokens must be non-negative and smaller than chunk_tokens")

    max_chars = chunk_tokens * CHARS_PER_TOKEN
    overlap_chars = overlap_tokens * CHARS_PER_TOKEN

    chunks: list[Chunk] = []
    for segment in document.segments:
        if segment.is_empty:
            continue
        for piece in _split_segment(segment, max_chars=max_chars, overlap_chars=overlap_chars):
            chunks.append(
                Chunk(
                    id=_chunk_id(document.content_sha256, len(chunks), piece),
                    text=piece,
                    index=len(chunks),
                    kind=segment.kind,
                    start=segment.start,
                    end=segment.end,
                    heading=segment.heading,
                )
            )

    return ChunkIndex(items=chunks, source_sha256=document.content_sha256)


def _split_segment(segment: Segment, *, max_chars: int, overlap_chars: int) -> list[str]:
    """Split one segment, preferring sentence boundaries."""
    text = segment.text.strip()
    if len(text) <= max_chars:
        return [text] if text else []

    sentences = _SENTENCE_END.split(text)
    pieces: list[str] = []
    current: list[str] = []
    current_length = 0

    for sentence in sentences:
        # A single sentence longer than the whole budget is split on whitespace. Rare, but a
        # table of contents or a transcript without punctuation produces exactly this.
        if len(sentence) > max_chars:
            if current:
                pieces.append(" ".join(current))
                current, current_length = [], 0
            pieces.extend(_split_hard(sentence, max_chars))
            continue

        if current_length + len(sentence) + 1 > max_chars and current:
            pieces.append(" ".join(current))
            tail = _overlap_tail(current, overlap_chars)
            current = list(tail)
            current_length = sum(len(part) + 1 for part in current)

        current.append(sentence)
        current_length += len(sentence) + 1

    if current:
        trailing = " ".join(current)
        # Fold a short tail back rather than paying a model call for a fragment.
        if pieces and len(trailing) < MIN_CHUNK_CHARS:
            pieces[-1] = f"{pieces[-1]} {trailing}".strip()
        else:
            pieces.append(trailing)

    return [piece.strip() for piece in pieces if piece.strip()]


def _overlap_tail(sentences: list[str], overlap_chars: int) -> list[str]:
    """The last few sentences, up to the overlap budget.

    The overlap is what keeps a concept that straddles a chunk boundary from being lost: it
    appears whole in at least one chunk, and the merge stage deduplicates the repeat.
    """
    if overlap_chars <= 0:
        return []
    tail: list[str] = []
    length = 0
    for sentence in reversed(sentences):
        if length + len(sentence) > overlap_chars and tail:
            break
        tail.insert(0, sentence)
        length += len(sentence) + 1
    return tail


def _split_hard(text: str, max_chars: int) -> list[str]:
    words = text.split()
    pieces: list[str] = []
    current: list[str] = []
    length = 0
    for word in words:
        if length + len(word) + 1 > max_chars and current:
            pieces.append(" ".join(current))
            current, length = [], 0
        current.append(word)
        length += len(word) + 1
    if current:
        pieces.append(" ".join(current))
    return pieces


def _chunk_id(source_sha: str, index: int, text: str) -> str:
    """Deterministic in the source, the position and the content.

    All three matter: the source so chunks from different uploads never collide, the index so
    an identical repeated passage yields distinct chunks, and the content so a changed chunker
    produces new ids and correctly invalidates stored work.
    """
    digest = hashlib.sha256(f"{source_sha}:{index}:{text}".encode()).hexdigest()
    return digest[:32]
