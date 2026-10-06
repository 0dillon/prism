"""Object paths and upload validation.

The client never chooses where a file lands. A path is generated here from the owner id, the
lesson id, and random bytes, which closes three problems at once:

* **Path traversal.** A filename of `../../other-user/secret.pdf` cannot escape, because the
  original filename is never part of the path. Only its extension survives, and only after
  being checked against an allowlist.
* **Overwriting someone else's object.** The random component means a second upload cannot
  land on an existing object, deliberately or by collision.
* **Authorisation from the path.** Because the first segment is always the owner id, the
  storage policy can authorise against the path alone. That is only sound while the server
  generates the path - accepting a client-supplied one would make the same check meaningless.

File type is checked three ways, because any one of them alone is weak: the extension (which
a client controls), the declared content type (which a client also controls), and the leading
bytes of the file (which it does not).
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass
from typing import Final
from uuid import UUID

# PRD CE-1: .pdf, .txt, .md, .docx, .mp3, .wav, .m4a up to 50 MB.
ALLOWED_SOURCE_EXTENSIONS: Final[dict[str, str]] = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
}

# Leading bytes, for the formats that have a reliable signature. Text and Markdown have none,
# which is itself the reason they are treated as text rather than trusted as anything else.
_MAGIC_BYTES: Final[dict[str, tuple[bytes, ...]]] = {
    ".pdf": (b"%PDF-",),
    ".docx": (b"PK\x03\x04",),  # a zip container
    ".mp3": (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"),
    ".wav": (b"RIFF",),
    ".m4a": (b"\x00\x00\x00",),  # ftyp box; the brand follows at offset 4
}

_SAFE_SEGMENT: Final = re.compile(r"\A[a-f0-9-]{36}\Z")

SOURCES_BUCKET: Final = "sources"
LESSON_MEDIA_BUCKET: Final = "lesson-media"
SIGN_CLIPS_BUCKET: Final = "sign-clips"


class UploadRejectedError(ValueError):
    """The upload is not acceptable. The message is safe to show the uploader."""


@dataclass(frozen=True, slots=True)
class StorageObject:
    bucket: str
    path: str
    content_type: str

    @property
    def full_path(self) -> str:
        return f"{self.bucket}/{self.path}"


def normalise_extension(filename: str) -> str:
    """The lowercased extension of a filename, with nothing else carried over."""
    name = filename.strip().rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." not in name:
        raise UploadRejectedError("The file needs an extension so Prism knows how to read it.")
    return "." + name.rsplit(".", 1)[-1].lower()


def validate_source_upload(
    *,
    filename: str,
    content_type: str | None,
    size_bytes: int,
    max_bytes: int,
    head: bytes | None = None,
) -> str:
    """Check an intended upload and return its canonical content type.

    `head` is the first few bytes of the file where they are available. When they are, they
    are the only part of this check a client cannot simply assert.
    """
    extension = normalise_extension(filename)
    if extension not in ALLOWED_SOURCE_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_SOURCE_EXTENSIONS))
        raise UploadRejectedError(f"Prism accepts {allowed}. It cannot read {extension} files.")

    if size_bytes <= 0:
        raise UploadRejectedError("The file appears to be empty.")
    if size_bytes > max_bytes:
        megabytes = max_bytes // (1024 * 1024)
        raise UploadRejectedError(f"Files must be {megabytes} MB or smaller.")

    expected_type = ALLOWED_SOURCE_EXTENSIONS[extension]
    if content_type and content_type.split(";")[0].strip().lower() != expected_type:
        raise UploadRejectedError(
            f"The file says it is {content_type}, which does not match a {extension} file."
        )

    if head is not None and not _signature_matches(extension, head):
        raise UploadRejectedError(
            f"The contents of this file do not look like a {extension} file."
        )

    return expected_type


def _signature_matches(extension: str, head: bytes) -> bool:
    signatures = _MAGIC_BYTES.get(extension)
    if signatures is None:
        # Text and Markdown have no signature. Reject bytes that cannot be text at all, so a
        # binary payload cannot be smuggled in as a .txt.
        return _looks_like_text(head)
    if extension == ".m4a":
        return len(head) >= 8 and head[4:8] == b"ftyp"
    return any(head.startswith(signature) for signature in signatures)


def _looks_like_text(head: bytes) -> bool:
    if b"\x00" in head:
        return False
    try:
        head.decode("utf-8")
    except UnicodeDecodeError:
        # A chunk boundary can split a multi-byte character, so a decode failure at the very
        # end of the sample is not evidence of binary content.
        try:
            head[:-3].decode("utf-8")
        except UnicodeDecodeError:
            return False
    return True


def source_object_path(*, owner_id: UUID, lesson_id: UUID, extension: str) -> str:
    """`{owner_id}/{lesson_id}/{random}{extension}`.

    The owner id leads so the storage policy can authorise from the path alone.
    """
    if extension not in ALLOWED_SOURCE_EXTENSIONS:
        raise UploadRejectedError(f"{extension} files are not accepted.")
    token = secrets.token_hex(16)
    return f"{owner_id}/{lesson_id}/{token}{extension}"


def lesson_media_object_path(*, lesson_id: UUID, extension: str) -> str:
    token = secrets.token_hex(16)
    return f"{lesson_id}/{token}{extension.lower()}"


def owner_of(path: str) -> UUID | None:
    """The owner id encoded in a source path, or None if the path is not one of ours."""
    first = path.split("/", 1)[0]
    if not _SAFE_SEGMENT.match(first):
        return None
    try:
        return UUID(first)
    except ValueError:
        return None


def assert_path_is_safe(path: str) -> None:
    """Reject anything that is not a plain generated path.

    Defence in depth: nothing should ever reach here with a traversal sequence, because paths
    are generated rather than accepted. This is the check that notices if that ever stops
    being true.
    """
    if not path or path.startswith("/") or path.startswith("\\"):
        raise UploadRejectedError("Invalid storage path.")
    if ".." in path or "\\" in path or "//" in path:
        raise UploadRejectedError("Invalid storage path.")
    if any(ord(ch) < 32 for ch in path):
        raise UploadRejectedError("Invalid storage path.")
