/**
 * Builds a small, valid, text-layer PDF for tests. Each entry in `pages` is one page and
 * each string in it is one line. ASCII only. No binary fixture files are needed.
 */
export function makePdf(pages: string[][]): Uint8Array {
  const escape = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

  // Object numbers: 1 catalog, 2 page tree, 3 font, then a page and a content stream per page.
  const pageObjectNumber = (index: number) => 4 + index * 2;
  const contentObjectNumber = (index: number) => 5 + index * 2;

  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pages
    .map((_, i) => `${pageObjectNumber(i)} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  pages.forEach((lines, i) => {
    const stream = `BT /F1 12 Tf 14 TL 72 720 Td ${lines
      .map((line) => `(${escape(line)}) Tj T*`)
      .join(" ")} ET`;
    objects[pageObjectNumber(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjectNumber(i)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`;
    objects[contentObjectNumber(i)] =
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = body.length;
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) {
    body += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(body);
}
