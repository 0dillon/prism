import { extractText, getDocumentProxy } from "unpdf";
import { MAX_UPLOAD_BYTES, sourceTypeFromFileName } from "@/lib/supabase/storage";
import { ExtractionError, type SourceDocument, type SourceSegment } from "./types";

/**
 * Step 2 of ingestion (PRD 5.1): turn an uploaded file into a SourceDocument, an
 * ordered list of text segments that each remember where they came from.
 *
 * - txt and md: segments are paragraphs and headings, located by character offset.
 * - pdf: segments are headings and the text under them, located by page number.
 * - docx and audio are handled by P2-19 and P2-18 and rejected here until then.
 */

export interface ExtractInput {
  fileName: string;
  data: Uint8Array;
}

export async function extractSourceDocument(input: ExtractInput): Promise<SourceDocument> {
  if (input.data.byteLength === 0) throw new ExtractionError("The file is empty.");
  if (input.data.byteLength > MAX_UPLOAD_BYTES) {
    throw new ExtractionError("The file is larger than the 50 MB limit.");
  }
  const type = sourceTypeFromFileName(input.fileName);
  switch (type) {
    case "txt":
    case "md":
      return extractPlainText(new TextDecoder("utf-8").decode(input.data), type);
    case "pdf":
      return extractPdf(input.data);
    case "docx":
      throw new ExtractionError("Word documents are not supported yet.");
    case "audio":
      throw new ExtractionError("Audio files are not supported yet.");
    default:
      throw new ExtractionError("This file type is not supported.");
  }
}

const TERMINAL_PUNCTUATION = /[.!?,;:]$/;
const SENTENCE_END = /[.!?:"')\]]$/;
const PAGE_NUMBER = /^(page\s+)?\d{1,4}(\s+of\s+\d{1,4})?$/i;

/**
 * Whether a standalone line reads like a heading: short, a few words, capitalized or
 * numbered, and not ending like a sentence.
 */
export function looksLikeHeading(line: string): boolean {
  const text = line.trim();
  if (text.length === 0 || text.length > 70) return false;
  if (TERMINAL_PUNCTUATION.test(text)) return false;
  if (!/^[A-Z0-9]/.test(text)) return false;
  if (text.split(/\s+/).length > 10) return false;
  return !PAGE_NUMBER.test(text);
}

function collapse(text: string): string {
  return text.replace(/[ \t]+/g, " ").trim();
}

/** Plain text and Markdown. Offsets index into the text after BOM and CRLF normalization. */
export function extractPlainText(raw: string, kind: "txt" | "md"): SourceDocument {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const segments: SourceSegment[] = [];

  let paragraph: { start: number; end: number; lines: string[] } | null = null;
  let offset = 0;

  const flush = () => {
    if (!paragraph) return;
    const body = paragraph.lines.map(collapse).filter(Boolean).join("\n");
    if (body) {
      segments.push({
        text: body,
        locator: { kind: "offset", start: paragraph.start, end: paragraph.end },
      });
    }
    paragraph = null;
  };

  lines.forEach((line, index) => {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      return;
    }

    if (kind === "md") {
      const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
      if (match) {
        flush();
        if (match[2]) {
          segments.push({
            text: match[2],
            locator: { kind: "offset", start: lineStart, end: lineEnd },
            heading: { level: match[1].length },
          });
        }
        return;
      }
    } else {
      const blankBefore = index === 0 || lines[index - 1].trim() === "";
      const blankAfter = index === lines.length - 1 || lines[index + 1].trim() === "";
      if (!paragraph && blankBefore && blankAfter && looksLikeHeading(trimmed)) {
        segments.push({
          text: trimmed,
          locator: { kind: "offset", start: lineStart, end: lineEnd },
          heading: { level: 2 },
        });
        return;
      }
    }

    if (!paragraph) paragraph = { start: lineStart, end: lineEnd, lines: [] };
    paragraph.lines.push(line);
    paragraph.end = lineEnd;
  });
  flush();

  if (segments.length === 0) throw new ExtractionError("The file has no readable text.");
  return { sourceType: kind, segments };
}

/** Joins wrapped lines into one paragraph and repairs words hyphenated across a line break. */
function joinWrappedLines(lines: string[]): string {
  let result = "";
  for (const line of lines) {
    if (!result) result = line;
    else if (/[A-Za-z]-$/.test(result) && /^[a-z]/.test(line)) result = result.slice(0, -1) + line;
    else result += ` ${line}`;
  }
  return collapse(result);
}

/** Splits one PDF page's text into heading and body segments. */
function segmentPage(pageText: string, page: number): SourceSegment[] {
  const lines = pageText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !PAGE_NUMBER.test(line));

  const segments: SourceSegment[] = [];
  let body: string[] = [];
  let previousWasHeading = false;

  const flushBody = () => {
    if (body.length === 0) return;
    const text = joinWrappedLines(body);
    if (text) segments.push({ text, locator: { kind: "page", start: page } });
    body = [];
  };

  lines.forEach((line, index) => {
    const startsSection = index === 0 || previousWasHeading || SENTENCE_END.test(lines[index - 1]);
    // A line followed by a lowercase line is a wrapped sentence, not a heading.
    const continuesOnNextLine = index + 1 < lines.length && /^[a-z]/.test(lines[index + 1]);
    if (looksLikeHeading(line) && startsSection && !continuesOnNextLine) {
      flushBody();
      segments.push({
        text: line,
        locator: { kind: "page", start: page },
        heading: { level: 2 },
      });
      previousWasHeading = true;
    } else {
      body.push(line);
      previousWasHeading = false;
    }
  });
  flushBody();
  return segments;
}

export async function extractPdf(data: Uint8Array): Promise<SourceDocument> {
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text;
  } catch {
    throw new ExtractionError(
      "The PDF could not be read. It may be damaged or password protected.",
    );
  }

  const segments = pages.flatMap((text, index) => segmentPage(text, index + 1));
  if (segments.length === 0) {
    throw new ExtractionError(
      "The PDF has no text layer. Scanned PDFs need OCR, which is not supported yet.",
    );
  }
  return { sourceType: "pdf", segments };
}

/** The document's text with segments separated by blank lines. Used to check excerpts. */
export function documentPlainText(doc: SourceDocument): string {
  return doc.segments.map((segment) => segment.text).join("\n\n");
}
