import { describe, expect, it } from "vitest";
import {
  documentPlainText,
  extractPlainText,
  extractSourceDocument,
  looksLikeHeading,
} from "@/lib/ai/ingestion/extract";
import { ExtractionError, SourceDocument } from "@/lib/ai/ingestion/types";
import { makePdf } from "../fixtures/pdf";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("looksLikeHeading", () => {
  it.each(["Evaporation", "1. Introduction", "How water moves", "Section 2 The ocean"])(
    "accepts %s",
    (line) => {
      expect(looksLikeHeading(line)).toBe(true);
    },
  );

  it.each([
    "",
    "The sun warms the water in oceans and lakes.",
    "lowercase start",
    "Ends with a colon:",
    "This line has far too many words to ever be considered a short heading line",
    "Page 4",
    "12",
    "x".repeat(80),
  ])("rejects %j", (line) => {
    expect(looksLikeHeading(line)).toBe(false);
  });
});

describe("plain text extraction", () => {
  it("splits paragraphs and records character offsets", () => {
    const text = "First paragraph here.\n\nSecond paragraph\ncontinues here.";
    const doc = extractPlainText(text, "txt");
    expect(doc.segments.map((s) => s.text)).toEqual([
      "First paragraph here.",
      "Second paragraph\ncontinues here.",
    ]);
    const first = doc.segments[0].locator;
    expect(text.slice(first.start, first.end)).toBe("First paragraph here.");
    const second = doc.segments[1].locator;
    expect(text.slice(second.start, second.end)).toBe("Second paragraph\ncontinues here.");
    expect(doc.segments.every((s) => s.locator.kind === "offset")).toBe(true);
  });

  it("detects headings in plain text from short standalone lines", () => {
    const doc = extractPlainText(
      "Water Cycle\n\nWater moves between the sea and the sky.\n\nCondensation\n\nVapor cools.",
      "txt",
    );
    expect(doc.segments.map((s) => [s.text, s.heading?.level])).toEqual([
      ["Water Cycle", 2],
      ["Water moves between the sea and the sky.", undefined],
      ["Condensation", 2],
      ["Vapor cools.", undefined],
    ]);
  });

  it("reads markdown headings with their level and keeps their offsets", () => {
    const text = "# Water\n\nIntro text.\n\n## Evaporation ##\n\nHeat makes vapor.";
    const doc = extractPlainText(text, "md");
    expect(doc.segments.map((s) => [s.text, s.heading?.level])).toEqual([
      ["Water", 1],
      ["Intro text.", undefined],
      ["Evaporation", 2],
      ["Heat makes vapor.", undefined],
    ]);
    const heading = doc.segments[2].locator;
    expect(text.slice(heading.start, heading.end)).toBe("## Evaporation ##");
  });

  it("does not treat a lone short line in markdown as a heading", () => {
    const doc = extractPlainText("Intro\n\nBody text.", "md");
    expect(doc.segments.every((s) => s.heading === undefined)).toBe(true);
  });

  it("normalizes CRLF line endings and a byte order mark", () => {
    const doc = extractPlainText("﻿Line one.\r\n\r\nLine two.\r\n", "txt");
    expect(doc.segments.map((s) => s.text)).toEqual(["Line one.", "Line two."]);
  });

  it("rejects text with no readable content", () => {
    expect(() => extractPlainText("  \n\n \n", "txt")).toThrow(ExtractionError);
  });

  it("produces a document that passes the schema", () => {
    expect(SourceDocument.safeParse(extractPlainText("A.\n\nB.", "txt")).success).toBe(true);
  });
});

describe("pdf extraction", () => {
  const pdf = makePdf([
    ["Water Cycle", "", "The sun warms water in oceans and lakes.", "Some of it becomes vapor."],
    ["Condensation", "Vapor cools high in the sky and forms", "clouds of tiny droplets."],
    ["Precipitation", "Heavy droplets fall as rain."],
  ]);

  it("yields segments with the correct page numbers", async () => {
    const doc = await extractSourceDocument({ fileName: "lesson.pdf", data: pdf });
    expect(doc.sourceType).toBe("pdf");
    expect(doc.segments.map((s) => [s.locator.kind, s.locator.start, s.text])).toEqual([
      ["page", 1, "Water Cycle"],
      ["page", 1, "The sun warms water in oceans and lakes. Some of it becomes vapor."],
      ["page", 2, "Condensation"],
      ["page", 2, "Vapor cools high in the sky and forms clouds of tiny droplets."],
      ["page", 3, "Precipitation"],
      ["page", 3, "Heavy droplets fall as rain."],
    ]);
  });

  it("marks headings and leaves body text unmarked", async () => {
    const doc = await extractSourceDocument({ fileName: "lesson.pdf", data: pdf });
    expect(doc.segments.map((s) => s.heading?.level ?? null)).toEqual([2, null, 2, null, 2, null]);
  });

  it("repairs a word hyphenated across a line break", async () => {
    const hyphenated = makePdf([
      ["The water cycle is a continu-", "ous process that never stops."],
    ]);
    const doc = await extractSourceDocument({ fileName: "a.pdf", data: hyphenated });
    expect(doc.segments[0].text).toBe("The water cycle is a continuous process that never stops.");
  });

  it("drops bare page numbers", async () => {
    const withNumbers = makePdf([
      ["Intro text goes here.", "1"],
      ["More text goes here.", "Page 2"],
    ]);
    const doc = await extractSourceDocument({ fileName: "a.pdf", data: withNumbers });
    expect(doc.segments.map((s) => s.text)).toEqual([
      "Intro text goes here.",
      "More text goes here.",
    ]);
  });

  it("keeps page numbers for pages that have text after blank pages", async () => {
    const sparse = makePdf([["First page text."], [], ["Third page text."]]);
    const doc = await extractSourceDocument({ fileName: "a.pdf", data: sparse });
    expect(doc.segments.map((s) => s.locator.start)).toEqual([1, 3]);
  });

  it("rejects a PDF with no text layer", async () => {
    await expect(
      extractSourceDocument({ fileName: "scan.pdf", data: makePdf([[], []]) }),
    ).rejects.toThrow(/no text layer/);
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(
      extractSourceDocument({ fileName: "bad.pdf", data: bytes("this is not a pdf") }),
    ).rejects.toThrow(/could not be read/);
  });

  it("produces text that contains the page's verbatim sentences", async () => {
    const doc = await extractSourceDocument({ fileName: "lesson.pdf", data: pdf });
    expect(documentPlainText(doc)).toContain("The sun warms water in oceans and lakes.");
  });
});

describe("extractSourceDocument", () => {
  it("routes by file extension", async () => {
    const md = await extractSourceDocument({ fileName: "n.MD", data: bytes("# Title\n\nBody.") });
    expect(md.sourceType).toBe("md");
    const txt = await extractSourceDocument({ fileName: "n.txt", data: bytes("Body text.") });
    expect(txt.sourceType).toBe("txt");
  });

  it.each([
    ["empty file", "a.txt", new Uint8Array(0), /empty/],
    ["unsupported type", "a.exe", bytes("x"), /not supported/],
    ["docx before P2-19", "a.docx", bytes("x"), /Word documents/],
    ["audio before P2-18", "a.mp3", bytes("x"), /Audio files/],
  ])("rejects %s", async (_label, fileName, data, message) => {
    await expect(extractSourceDocument({ fileName, data })).rejects.toThrow(message);
  });
});
