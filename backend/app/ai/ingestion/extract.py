"""Text extraction (PRD 5.1 step 2, task P2-02).

Produces a `SourceDocument`: ordered segments, each carrying the text and a locator back to
where it came from. The locator is not decoration. PRD CE-1 requires every concept to link
back to its place in the source, CE-2 shows the excerpt beside the concept during review, and
the visual renderer seeks audio from it. Losing the locator during extraction means none of
that can be reconstructed later.

MVP formats are plain text, Markdown and PDF. DOCX and audio have their own stages later;
the shapes here already accommodate them, which is why the locator kind is an enum rather
than a page number.
"""

from __future__ import annotations

import hashlib
import io
import re
from dataclasses import dataclass, field
from typing import Literal

from app.core.logging import get_logger

logger = get_logger(__name__)

LocatorKind = Literal["page", "time", "offset"]


class ExtractionError(ValueError):
    """The file could not be read. The message is shown to the uploader."""


@dataclass(frozen=True, slots=True)
class Segment:
    """A contiguous piece of the source and where it came from."""

    text: str
    kind: LocatorKind
    start: float
    end: float | None = None
    heading: str | None = None

    @property
    def is_empty(self) -> bool:
        return not self.text.strip()


@dataclass(slots=True)
class SourceDocument:
    """The whole source, as ordered segments."""

    segments: list[Segment] = field(default_factory=list)
    title: str | None = None
    content_sha256: str = ""

    @property
    def full_text(self) -> str:
        """The document as one string, for the grounding check."""
        return "\n\n".join(segment.text for segment in self.segments)

    @property
    def total_characters(self) -> int:
        return sum(len(segment.text) for segment in self.segments)

    def is_empty(self) -> bool:
        return all(segment.is_empty for segment in self.segments)


# Markdown and plain-text headings. A line of fewer than 80 characters in title case with no
# terminal punctuation is treated as a heading too, which is how most plain-text documents
# actually mark their structure.
_MD_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
_SETEXT_HEADING = re.compile(r"^(.+)\n(=+|-+)\s*$", re.MULTILINE)


def extract(
    *, data: bytes, source_type: str, filename: str | None = None
) -> SourceDocument:
    """Read a source file into segments.

    `source_type` is the validated type from upload, never the client's assertion about the
    file: the extension and declared content type were checked against the file's own bytes
    before this point.
    """
    if not data:
        raise ExtractionError("The file is empty.")

    if source_type in ("text", "markdown"):
        document = _extract_text(data)
    elif source_type == "pdf":
        document = _extract_pdf(data)
    else:
        raise ExtractionError(
            f"Prism cannot read {source_type} files yet. Upload a PDF, text or Markdown file."
        )

    if document.is_empty():
        raise ExtractionError(
            "No readable text was found. If this is a scanned document, Prism cannot read "
            "images of text yet."
        )

    document.content_sha256 = hashlib.sha256(data).hexdigest()
    if document.title is None and filename:
        document.title = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip()
    return document


# --------------------------------------------------------------------------
def _extract_text(data: bytes) -> SourceDocument:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = data.decode("utf-8", errors="replace")
            logger.warning("extract_text_replaced_invalid_bytes")
        except Exception as exc:  # pragma: no cover - decode with replace does not raise
            raise ExtractionError("The file is not readable as text.") from exc

    segments: list[Segment] = []
    offset = 0
    for heading, body in _split_on_headings(text):
        if not body.strip():
            offset += len(body)
            continue
        segments.append(
            Segment(
                text=body.strip(),
                kind="offset",
                start=offset,
                end=offset + len(body),
                heading=heading,
            )
        )
        offset += len(body)

    title = segments[0].heading if segments and segments[0].heading else None
    return SourceDocument(segments=segments, title=title)


def _split_on_headings(text: str) -> list[tuple[str | None, str]]:
    """Split text into (heading, body) pairs, preserving order and the text in between."""
    normalised = text.replace("\r\n", "\n").replace("\r", "\n")
    matches = list(_MD_HEADING.finditer(normalised))
    if not matches:
        return [(None, normalised)]

    sections: list[tuple[str | None, str]] = []
    if matches[0].start() > 0:
        preamble = normalised[: matches[0].start()]
        if preamble.strip():
            sections.append((None, preamble))

    for index, match in enumerate(matches):
        body_start = match.end()
        body_end = (
            matches[index + 1].start() if index + 1 < len(matches) else len(normalised)
        )
        sections.append((match.group(2).strip(), normalised[body_start:body_end]))
    return sections


def _extract_pdf(data: bytes) -> SourceDocument:
    """One segment per page, so page locators are exact.

    PDFs with no text layer yield nothing here. That is reported as a clear message rather
    than an empty lesson: OCR is explicitly post-MVP (PRD 7.2), and a teacher who uploaded a
    scan needs to be told that, not handed a lesson with no content.
    """
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise ExtractionError("PDF support is not installed.") from exc

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        raise ExtractionError("This PDF could not be opened. It may be corrupted.") from exc

    if getattr(reader, "is_encrypted", False):
        raise ExtractionError(
            "This PDF is password protected. Remove the password and upload it again."
        )

    segments: list[Segment] = []
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            logger.warning("pdf_page_unreadable", extra={"page": page_number})
            continue
        if text.strip():
            segments.append(
                Segment(
                    text=_tidy_pdf_text(text),
                    kind="page",
                    start=page_number,
                    end=page_number,
                )
            )

    title = None
    metadata = getattr(reader, "metadata", None)
    if metadata is not None:
        raw_title = getattr(metadata, "title", None)
        if isinstance(raw_title, str) and raw_title.strip():
            title = raw_title.strip()

    return SourceDocument(segments=segments, title=title)


def _tidy_pdf_text(text: str) -> str:
    """Undo the two artefacts PDF text layers reliably introduce.

    Left alone, hyphenated line breaks and hard-wrapped lines make the grounding check fail on
    perfectly honest extractions, because the model quotes the sentence as it reads rather
    than as the bytes happen to be laid out.
    """
    joined = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    joined = re.sub(r"(?<![\n.!?:;])\n(?!\n)", " ", joined)
    return re.sub(r"[ \t]{2,}", " ", joined).strip()
