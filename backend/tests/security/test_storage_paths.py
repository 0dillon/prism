"""Upload validation and path generation (brief sections 11 and 38)."""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest

from app.storage.paths import (
    ALLOWED_SOURCE_EXTENSIONS,
    UploadRejectedError,
    assert_path_is_safe,
    normalise_extension,
    owner_of,
    source_object_path,
    validate_source_upload,
)

MAX_BYTES = 50 * 1024 * 1024


def check(filename: str, **kwargs: object) -> str:
    params: dict[str, object] = {
        "content_type": None,
        "size_bytes": 1024,
        "max_bytes": MAX_BYTES,
    }
    params.update(kwargs)
    return validate_source_upload(filename=filename, **params)  # type: ignore[arg-type]


class TestAcceptedFormats:
    @pytest.mark.parametrize("extension", sorted(ALLOWED_SOURCE_EXTENSIONS))
    def test_every_prd_format_is_accepted(self, extension: str) -> None:
        """PRD CE-1 lists .pdf, .txt, .md, .docx, .mp3, .wav, .m4a."""
        assert check(f"lesson{extension}") == ALLOWED_SOURCE_EXTENSIONS[extension]

    def test_the_prd_format_list_is_exactly_what_is_allowed(self) -> None:
        assert set(ALLOWED_SOURCE_EXTENSIONS) == {
            ".pdf", ".txt", ".md", ".docx", ".mp3", ".wav", ".m4a"
        }

    @pytest.mark.parametrize("filename", ["LESSON.PDF", "Lesson.Pdf"])
    def test_extension_matching_is_case_insensitive(self, filename: str) -> None:
        assert check(filename) == "application/pdf"


class TestRejectedUploads:
    @pytest.mark.parametrize(
        "filename", ["script.exe", "payload.sh", "page.html", "archive.zip", "image.svg"]
    )
    def test_disallowed_extensions_are_rejected(self, filename: str) -> None:
        with pytest.raises(UploadRejectedError):
            check(filename)

    def test_a_file_without_an_extension_is_rejected(self) -> None:
        with pytest.raises(UploadRejectedError):
            check("lesson")

    def test_an_oversized_file_is_rejected(self) -> None:
        """PRD CE-1 caps uploads at 50 MB."""
        with pytest.raises(UploadRejectedError, match="50 MB"):
            check("lesson.pdf", size_bytes=MAX_BYTES + 1)

    def test_an_empty_file_is_rejected(self) -> None:
        with pytest.raises(UploadRejectedError):
            check("lesson.pdf", size_bytes=0)

    def test_a_mismatched_content_type_is_rejected(self) -> None:
        with pytest.raises(UploadRejectedError, match="does not match"):
            check("lesson.pdf", content_type="text/html")

    def test_a_double_extension_is_judged_by_its_last_one(self) -> None:
        """`payload.pdf.exe` is an executable, whatever the middle segment suggests."""
        with pytest.raises(UploadRejectedError):
            check("payload.pdf.exe")


class TestContentSniffing:
    def test_a_pdf_must_actually_start_like_a_pdf(self) -> None:
        """The extension and content type are both client-controlled; the bytes are not."""
        assert check("lesson.pdf", head=b"%PDF-1.7\n...") == "application/pdf"

        with pytest.raises(UploadRejectedError, match="do not look like"):
            check("lesson.pdf", head=b"MZ\x90\x00")  # a Windows executable

    def test_a_docx_must_be_a_zip_container(self) -> None:
        assert check("lesson.docx", head=b"PK\x03\x04rest")
        with pytest.raises(UploadRejectedError):
            check("lesson.docx", head=b"not a zip")

    def test_audio_signatures_are_checked(self) -> None:
        assert check("clip.mp3", head=b"ID3\x04\x00")
        assert check("clip.wav", head=b"RIFF....WAVE")
        assert check("clip.m4a", head=b"\x00\x00\x00 ftypM4A ")

        with pytest.raises(UploadRejectedError):
            check("clip.mp3", head=b"%PDF-1.7")

    def test_a_binary_payload_cannot_masquerade_as_text(self) -> None:
        assert check("notes.txt", head=b"Plain notes about the water cycle.")
        with pytest.raises(UploadRejectedError):
            check("notes.txt", head=b"\x00\x01\x02\x03binary")

    def test_text_split_mid_character_is_still_accepted(self) -> None:
        """A sample taken at a byte boundary can cut a multi-byte character in half; that is
        not evidence of binary content."""
        assert check("notes.txt", head="Café notes — the water cycl".encode()[:-1])


class TestPathGeneration:
    def test_the_owner_leads_the_path(self) -> None:
        owner, lesson = uuid4(), uuid4()
        path = source_object_path(owner_id=owner, lesson_id=lesson, extension=".pdf")
        assert path.startswith(f"{owner}/{lesson}/")
        assert path.endswith(".pdf")

    def test_paths_are_unpredictable(self) -> None:
        owner, lesson = uuid4(), uuid4()
        paths = {
            source_object_path(owner_id=owner, lesson_id=lesson, extension=".pdf")
            for _ in range(200)
        }
        assert len(paths) == 200

    def test_the_original_filename_never_appears(self) -> None:
        """Which is what makes traversal and overwrite impossible rather than merely filtered."""
        owner, lesson = uuid4(), uuid4()
        path = source_object_path(owner_id=owner, lesson_id=lesson, extension=".pdf")
        assert "lesson" not in path.rsplit("/", 1)[-1].replace(".pdf", "")

    def test_the_owner_is_recoverable_from_the_path(self) -> None:
        owner, lesson = uuid4(), uuid4()
        path = source_object_path(owner_id=owner, lesson_id=lesson, extension=".pdf")
        assert owner_of(path) == owner

    def test_a_foreign_path_yields_no_owner(self) -> None:
        assert owner_of("../../etc/passwd") is None
        assert owner_of("not-a-uuid/file.pdf") is None


class TestPathTraversal:
    @pytest.mark.parametrize(
        "filename",
        [
            "../../../etc/passwd.pdf",
            "..\\..\\windows\\system32\\config.pdf",
            "/absolute/path.pdf",
            "nested/dir/lesson.pdf",
        ],
    )
    def test_traversal_attempts_cannot_influence_the_stored_path(
        self, filename: str
    ) -> None:
        """Only the extension survives, so the attempt has nothing to act on."""
        extension = normalise_extension(filename)
        assert extension == ".pdf"

        path = source_object_path(
            owner_id=UUID(int=1), lesson_id=UUID(int=2), extension=extension
        )
        assert ".." not in path
        assert path.count("/") == 2

    @pytest.mark.parametrize(
        "path",
        [
            "",
            "/leading-slash/file.pdf",
            "a/../../../b.pdf",
            "a//b.pdf",
            "a\\b.pdf",
            "a/\x00b.pdf",
        ],
    )
    def test_unsafe_paths_are_refused(self, path: str) -> None:
        with pytest.raises(UploadRejectedError):
            assert_path_is_safe(path)

    def test_a_generated_path_passes_the_safety_check(self) -> None:
        assert_path_is_safe(
            source_object_path(owner_id=uuid4(), lesson_id=uuid4(), extension=".pdf")
        )
