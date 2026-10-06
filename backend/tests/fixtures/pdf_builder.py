"""Builds a minimal, valid PDF with a real text layer.

Hand-assembled rather than generated with a library, for two reasons: it adds no dependency
for a test-only concern, and it produces a file whose exact contents are visible here, so a
failing extraction test points at the extractor rather than at a generator's behaviour.

The output is a standard PDF 1.4 document: a catalog, a pages tree, one page object per page
with a Helvetica font resource, and a content stream using BT/Tj/ET text operators.
"""

from __future__ import annotations


def build_pdf(pages: list[str]) -> bytes:
    """A PDF containing one page per string, each with that string as its text layer."""
    if not pages:
        raise ValueError("a PDF needs at least one page")

    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    # Object numbering is fixed up front so the pages tree can name its children.
    catalog_number = 1
    pages_number = 2
    font_number = 3
    first_page_number = 4

    page_numbers = [first_page_number + index * 2 for index in range(len(pages))]
    kids = " ".join(f"{number} 0 R" for number in page_numbers)

    add(f"<< /Type /Catalog /Pages {pages_number} 0 R >>".encode())
    add(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    for index, text in enumerate(pages):
        page_number = first_page_number + index * 2
        content_number = page_number + 1
        add(
            (
                f"<< /Type /Page /Parent {pages_number} 0 R "
                f"/MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font_number} 0 R >> >> "
                f"/Contents {content_number} 0 R >>"
            ).encode()
        )

        lines = text.split("\n")
        drawn = ["BT", "/F1 12 Tf", "72 720 Td", "14 TL"]
        for line_index, line in enumerate(lines):
            if line_index:
                drawn.append("T*")
            drawn.append(f"({_escape(line)}) Tj")
        drawn.append("ET")
        stream = "\n".join(drawn).encode("latin-1")
        add(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"

    xref_offset = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_number} 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode()
    return bytes(out)


def _escape(text: str) -> str:
    """Escape the three characters that are special inside a PDF string literal."""
    return (
        text.replace("\\", r"\\")
        .replace("(", r"\(")
        .replace(")", r"\)")
    )
