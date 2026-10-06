"""Text extraction and chunking (PRD tasks P2-02, P2-03)."""

from __future__ import annotations

import pytest

from app.ai.ingestion.chunk import (
    CHARS_PER_TOKEN,
    DEFAULT_CHUNK_TOKENS,
    chunk_document,
)
from app.ai.ingestion.extract import ExtractionError, SourceDocument, extract

MARKDOWN = """# The Water Cycle

Water moves continuously between the ground, the air and the clouds.

## Evaporation

Water evaporates when it is heated by the sun.

## Condensation

Vapour cools and condenses into droplets.
"""


class TestTextExtraction:
    def test_plain_text_becomes_one_segment(self) -> None:
        document = extract(data=b"Just some notes about rain.", source_type="text")
        assert len(document.segments) == 1
        assert "rain" in document.segments[0].text

    def test_markdown_is_split_on_headings(self) -> None:
        document = extract(data=MARKDOWN.encode(), source_type="markdown")
        headings = [segment.heading for segment in document.segments]
        assert "Evaporation" in headings
        assert "Condensation" in headings

    def test_the_title_comes_from_the_first_heading(self) -> None:
        document = extract(data=MARKDOWN.encode(), source_type="markdown")
        assert document.title == "The Water Cycle"

    def test_the_filename_is_a_fallback_title(self) -> None:
        document = extract(
            data=b"No headings here.", source_type="text", filename="water_cycle_notes.txt"
        )
        assert document.title == "water cycle notes"

    def test_every_segment_carries_a_locator(self) -> None:
        """PRD CE-1: every concept links back to its place in the source, and it inherits
        that link from the segment it came from."""
        document = extract(data=MARKDOWN.encode(), source_type="markdown")
        for segment in document.segments:
            assert segment.kind in ("page", "offset", "time")
            assert segment.start >= 0

    def test_the_content_hash_is_recorded(self) -> None:
        document = extract(data=b"Some text here.", source_type="text")
        assert len(document.content_sha256) == 64

    def test_the_same_bytes_hash_identically(self) -> None:
        first = extract(data=b"Some text here.", source_type="text")
        second = extract(data=b"Some text here.", source_type="text")
        assert first.content_sha256 == second.content_sha256

    def test_full_text_reassembles_the_document(self) -> None:
        document = extract(data=MARKDOWN.encode(), source_type="markdown")
        assert "Water evaporates" in document.full_text
        assert "Vapour cools" in document.full_text


class TestExtractionFailures:
    def test_an_empty_file_is_reported_clearly(self) -> None:
        with pytest.raises(ExtractionError, match="empty"):
            extract(data=b"", source_type="text")

    def test_a_whitespace_only_file_is_reported_clearly(self) -> None:
        with pytest.raises(ExtractionError, match="No readable text"):
            extract(data=b"   \n\n  \t ", source_type="text")

    def test_an_unsupported_type_names_what_is_supported(self) -> None:
        with pytest.raises(ExtractionError, match="PDF, text or Markdown"):
            extract(data=b"data", source_type="video")

    def test_invalid_utf8_does_not_crash_the_upload(self) -> None:
        """A teacher who saved their notes in a legacy encoding should get a lesson, not an
        error they cannot act on."""
        document = extract(data=b"Caf\xe9 notes about rain and clouds.", source_type="text")
        assert "notes about rain" in document.full_text


class TestChunking:
    def _document(self, text: str) -> SourceDocument:
        return extract(data=text.encode(), source_type="text")

    def test_a_short_document_is_one_chunk(self) -> None:
        index = chunk_document(self._document("A short lesson about rain."))
        assert len(index) == 1

    def test_no_chunk_exceeds_the_budget(self) -> None:
        """PRD task P2-03, done when: no chunk exceeds the limit."""
        sentence = "Water evaporates when the sun heats it and the vapour rises upward. "
        index = chunk_document(self._document(sentence * 500))

        limit = DEFAULT_CHUNK_TOKENS * CHARS_PER_TOKEN
        assert len(index) > 1
        for chunk in index.items:
            assert chunk.characters <= limit, chunk.characters

    def test_every_chunk_has_a_locator(self) -> None:
        """PRD task P2-03, done when: every chunk has at least one locator."""
        index = chunk_document(self._document(MARKDOWN))
        for chunk in index.items:
            assert chunk.kind in ("page", "offset", "time")
            assert chunk.start >= 0

    def test_chunks_overlap_so_a_straddling_idea_survives(self) -> None:
        """A concept spanning a boundary must appear whole in at least one chunk; the merge
        stage removes the duplicate."""
        sentences = [f"Sentence number {n} about the water cycle." for n in range(400)]
        index = chunk_document(self._document(" ".join(sentences)))

        assert len(index) > 1
        first_tail = index.items[0].text[-200:]
        second_head = index.items[1].text[:400]
        shared = {w for w in first_tail.split() if len(w) > 3} & set(second_head.split())
        assert shared, "consecutive chunks share no text, so the overlap is not working"

    def test_chunk_ids_are_deterministic(self) -> None:
        """What makes per-chunk resume possible: the same input yields the same ids, so a
        resumed job can skip the chunks it has already paid for."""
        document = self._document(MARKDOWN)
        assert chunk_document(document).ids() == chunk_document(document).ids()

    def test_chunk_ids_are_unique_within_a_document(self) -> None:
        repeated = "The very same paragraph, repeated verbatim many times over. " * 200
        index = chunk_document(self._document(repeated))
        assert len(set(index.ids())) == len(index)

    def test_different_documents_do_not_share_chunk_ids(self) -> None:
        first = chunk_document(self._document("A document about rain."))
        second = chunk_document(self._document("A document about snow."))
        assert not set(first.ids()) & set(second.ids())

    def test_a_changed_chunker_invalidates_stored_work(self) -> None:
        """Ids depend on content, so different chunking produces different ids and the map
        stage correctly re-runs instead of reusing shards for text that has moved."""
        document = self._document("Sentence about rain and clouds forming. " * 300)
        wide = chunk_document(document, chunk_tokens=1500)
        narrow = chunk_document(document, chunk_tokens=400)
        assert set(wide.ids()) != set(narrow.ids())

    def test_a_single_enormous_sentence_is_still_split(self) -> None:
        """A transcript without punctuation produces exactly this."""
        index = chunk_document(self._document("word " * 20_000))
        limit = DEFAULT_CHUNK_TOKENS * CHARS_PER_TOKEN
        assert len(index) > 1
        assert all(chunk.characters <= limit for chunk in index.items)

    def test_headings_are_carried_onto_chunks(self) -> None:
        index = chunk_document(self._document(MARKDOWN))
        assert any(chunk.heading == "Evaporation" for chunk in index.items)

    def test_a_chunk_can_be_found_by_id(self) -> None:
        index = chunk_document(self._document(MARKDOWN))
        first = index.items[0]
        assert index.by_id(first.id) == first
        assert index.by_id("not-a-chunk") is None

    @pytest.mark.parametrize(
        ("chunk_tokens", "overlap_tokens"),
        [(0, 0), (-1, 0), (100, 100), (100, 200), (100, -1)],
    )
    def test_invalid_chunking_parameters_are_refused(
        self, chunk_tokens: int, overlap_tokens: int
    ) -> None:
        with pytest.raises(ValueError):
            chunk_document(
                self._document("text"),
                chunk_tokens=chunk_tokens,
                overlap_tokens=overlap_tokens,
            )

    def test_chunk_text_together_covers_the_document(self) -> None:
        """Overlap means chunks repeat text, but nothing may be dropped between them."""
        sentences = [f"Fact {n} about evaporation and rain." for n in range(200)]
        document = self._document(" ".join(sentences))
        index = chunk_document(document)

        combined = " ".join(chunk.text for chunk in index.items)
        for sentence in (sentences[0], sentences[100], sentences[-1]):
            assert sentence in combined


class TestPdfExtraction:
    """PRD task P2-02, done when: a fixture PDF yields segments with correct page numbers."""

    def _pdf(self, pages: list[str]) -> bytes:
        from tests.fixtures.pdf_builder import build_pdf

        return build_pdf(pages)

    def test_each_page_becomes_a_segment_with_its_page_number(self) -> None:
        data = self._pdf(
            [
                "The Water Cycle\nWater evaporates when it is heated by the sun.",
                "Condensation\nVapour cools and condenses into droplets.",
                "Precipitation\nDroplets grow heavy and fall as rain.",
            ]
        )
        document = extract(data=data, source_type="pdf", filename="water.pdf")

        assert len(document.segments) == 3
        assert [segment.start for segment in document.segments] == [1, 2, 3]
        assert all(segment.kind == "page" for segment in document.segments)
        assert "evaporates" in document.segments[0].text
        assert "rain" in document.segments[2].text

    def test_page_locators_survive_chunking(self) -> None:
        """A concept inherits its chunk's locator, so losing it here loses CE-1."""
        data = self._pdf([f"Page {n} text about the water cycle and clouds." for n in range(1, 6)])
        index = chunk_document(extract(data=data, source_type="pdf"))

        assert {chunk.start for chunk in index.items} == {1, 2, 3, 4, 5}
        assert all(chunk.kind == "page" for chunk in index.items)

    def test_a_page_with_no_text_layer_is_skipped_not_faked(self) -> None:
        data = self._pdf(["Real text on the first page.", "", "More text on the third."])
        document = extract(data=data, source_type="pdf")

        assert [segment.start for segment in document.segments] == [1, 3]

    def test_a_scanned_pdf_says_so_rather_than_producing_an_empty_lesson(self) -> None:
        """OCR is post-MVP (PRD 7.2). A teacher who uploaded a scan needs to be told that."""
        data = self._pdf(["", "", ""])
        with pytest.raises(ExtractionError, match="scanned document"):
            extract(data=data, source_type="pdf")

    def test_a_corrupt_file_is_reported_clearly(self) -> None:
        with pytest.raises(ExtractionError, match="could not be opened"):
            extract(data=b"%PDF-1.4\nthis is not actually a pdf", source_type="pdf")

    def test_hyphenated_line_breaks_are_rejoined(self) -> None:
        """Left alone, these make the grounding check fail on honest extractions."""
        data = self._pdf(["Water evapo-\nrates when heated by the sun."])
        document = extract(data=data, source_type="pdf")
        assert "evaporates" in document.full_text
