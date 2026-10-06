// Renders the demo source (src/tests/fixtures/demo/water-cycle.md) to a text-layer PDF, so
// the demo can upload a real file. Run: npm run demo:pdf
//
// The PDF is plain Helvetica text, so it extracts cleanly and there is no binary to review.
import { readFileSync, writeFileSync } from "node:fs";
import { makePdf } from "../src/tests/fixtures/pdf";

const SOURCE = "src/tests/fixtures/demo/water-cycle.md";
const OUTPUT = "src/tests/fixtures/demo/water-cycle.pdf";
const LINES_PER_PAGE = 46;
const CHARS_PER_LINE = 80;

/** Keeps the text to ASCII, which the minimal PDF writer needs. */
function plain(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "");
}

function wrap(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > CHARS_PER_LINE) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const lines: string[] = [];
for (const raw of readFileSync(SOURCE, "utf8").split(/\r?\n/)) {
  const text = plain(raw).trim();
  if (!text) {
    lines.push("");
    continue;
  }
  const heading = /^(#{1,6})\s+(.*)$/.exec(text);
  if (heading) {
    // Headings are shown in capitals with space around them, which the extractor reads as a heading.
    if (lines.at(-1) !== "") lines.push("");
    lines.push(...wrap(heading[2].toUpperCase()), "");
    continue;
  }
  lines.push(...wrap(text.replace(/\*\*/g, "")));
}

const pages: string[][] = [];
for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

writeFileSync(OUTPUT, makePdf(pages));
console.log(`Wrote ${OUTPUT}: ${pages.length} pages, ${lines.length} lines.`);
