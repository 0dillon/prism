import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkDocument } from "@/lib/ai/ingestion/chunk";
import { documentPlainText, extractSourceDocument } from "@/lib/ai/ingestion/extract";
import { SAMPLE_LESSON } from "@/lib/demo/sample-lesson";

const MD = readFileSync("src/tests/fixtures/demo/water-cycle.md", "utf8");
const PDF = new Uint8Array(readFileSync("src/tests/fixtures/demo/water-cycle.pdf"));

describe("the demo source (P9-01)", () => {
  it("is a dense reading of three to five pages of everyday vocabulary", async () => {
    const doc = await extractSourceDocument({ fileName: "water-cycle.pdf", data: PDF });
    const pages = new Set(doc.segments.map((s) => s.locator.start));
    expect(pages.size).toBeGreaterThanOrEqual(3);
    expect(pages.size).toBeLessThanOrEqual(5);
    expect(MD.split(/\s+/).length).toBeGreaterThan(1200);
  });

  it("extracts cleanly from the PDF, with every key term of the demo lesson", async () => {
    const doc = await extractSourceDocument({ fileName: "water-cycle.pdf", data: PDF });
    const text = documentPlainText(doc).toLowerCase();
    for (const concept of SAMPLE_LESSON.concepts)
      expect(text).toContain(concept.keyTerm!.toLowerCase());
    expect(text).toContain("the water cycle");
  });

  it("splits into more than one chunk for the model", async () => {
    const doc = await extractSourceDocument({ fileName: "water-cycle.pdf", data: PDF });
    const chunks = chunkDocument(doc);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("is plain ASCII text in the PDF, with a text layer that matches the Markdown", async () => {
    const doc = await extractSourceDocument({ fileName: "water-cycle.pdf", data: PDF });
    const text = documentPlainText(doc).replace(/\s+/g, " ").toLowerCase();
    for (const phrase of [
      "evaporation happens faster when it is hot, dry, or windy",
      "a cloud is not water vapor",
      "it has no start and no end",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("names no condition", () => {
    expect(MD).not.toMatch(/adhd|dyslex|autis|blind|deaf|disabilit/i);
  });
});
