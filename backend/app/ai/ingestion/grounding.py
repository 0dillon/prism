"""Checking that extracted content actually came from the source.

PRD 5.1 step 7 and CE-1: every concept links back to its location in the source, and its
excerpt is verbatim supporting text. This module is what makes that claim checkable rather
than merely requested.

It is the layer that proves what the prompt defences in `app/ai/prompts/safety.py` only ask
for. A model that fabricates a fact, or that has been steered by text planted in the document,
cannot produce an excerpt that appears verbatim in the source - so comparing the returned
excerpt against the chunk it came from detects both, in code, without asking the model to
grade itself.

Matching is normalised rather than exact, because real extraction mangles text in ways that
have nothing to do with honesty: PDF text layers break ligatures, hyphenate across line ends,
and use typographic quotes and non-breaking spaces inconsistently. An exact comparison would
flag most of a legitimate PDF.

A failed check is always a flag, never a rejection. False positives are expected for the
reasons above, so the teacher adjudicates; PRD 5.1 step 9 lists flagged items first for
exactly this.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Final

# Below this, a "match" stops being evidence of anything.
MIN_EXCERPT_CHARS: Final = 12

_WHITESPACE: Final = re.compile(r"\s+")

# Characters a PDF text layer routinely substitutes, mapped back to their plain forms.
_SUBSTITUTIONS: Final[dict[str, str]] = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'",
    "“": '"', "”": '"', "„": '"',
    "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-",
    "―": "-", "−": "-",
    " ": " ", " ": " ", " ": " ", "​": "",
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
    "…": "...",
}


def normalise(text: str) -> str:
    """Fold text to a form where honest extraction differences disappear."""
    folded = unicodedata.normalize("NFKC", text)
    for source, replacement in _SUBSTITUTIONS.items():
        folded = folded.replace(source, replacement)
    # Join words hyphenated across a line break, which PDF extraction leaves behind.
    folded = re.sub(r"-\s*\n\s*", "", folded)
    folded = _WHITESPACE.sub(" ", folded)
    return folded.strip().casefold()


def excerpt_is_grounded(excerpt: str, source_text: str) -> bool:
    """Whether `excerpt` appears in `source_text` once both are normalised.

    A very short excerpt is treated as ungrounded: "water" appears in any document about the
    water cycle, so matching it would be evidence of nothing.
    """
    if len(excerpt.strip()) < MIN_EXCERPT_CHARS:
        return False
    return normalise(excerpt) in normalise(source_text)


def find_ungrounded(
    excerpts: dict[str, str], source_text: str
) -> dict[str, str]:
    """Map of id to excerpt, for every excerpt not found in the source."""
    return {
        identifier: excerpt
        for identifier, excerpt in excerpts.items()
        if not excerpt_is_grounded(excerpt, source_text)
    }


def coverage(excerpts: dict[str, str], source_text: str) -> float:
    """The proportion of excerpts that are grounded, for the ingestion evaluation script."""
    if not excerpts:
        return 1.0
    grounded = sum(
        1 for excerpt in excerpts.values() if excerpt_is_grounded(excerpt, source_text)
    )
    return grounded / len(excerpts)
