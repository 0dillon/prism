import { describe, expect, it } from "vitest";
import { Chunk, chunkDocument, estimateTokens } from "@/lib/ai/ingestion/chunk";
import { extractPlainText, extractSourceDocument } from "@/lib/ai/ingestion/extract";
import type { SourceDocument } from "@/lib/ai/ingestion/types";
import { makePdf } from "../fixtures/pdf";

/** A paragraph of `sentences` sentences, each about 60 characters, numbered so they are unique. */
function paragraph(tag: string, sentences: number): string {
  return Array.from(
    { length: sentences },
    (_, i) => `Sentence ${tag}${i} says that water changes state as it moves.`,
  ).join(" ");
}

function doc(segments: SourceDocument["segments"]): SourceDocument {
  return { sourceType: "txt", segments };
}

const body = (text: string, start: number) => ({
  text,
  locator: { kind: "offset" as const, start, end: start + text.length },
});
const heading = (text: string, start: number, level = 2) => ({
  text,
  locator: { kind: "offset" as const, start, end: start + text.length },
  heading: { level },
});

function bigDocument(sections: number, paragraphsPerSection: number, sentences: number) {
  const segments: SourceDocument["segments"] = [];
  let offset = 0;
  for (let s = 0; s < sections; s++) {
    segments.push(heading(`Section ${s}`, offset));
    offset += 20;
    for (let p = 0; p < paragraphsPerSection; p++) {
      const text = paragraph(`s${s}p${p}x`, sentences);
      segments.push(body(text, offset));
      offset += text.length + 2;
    }
  }
  return doc(segments);
}

describe("chunkDocument limits", () => {
  it.each([
    [1500, 150],
    [400, 40],
    [200, 60],
    [100, 0],
  ])("never exceeds the limit (max %i, overlap %i)", (maxTokens, overlapTokens) => {
    const chunks = chunkDocument(bigDocument(6, 4, 30), { maxTokens, overlapTokens });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(maxTokens);
      expect(chunk.tokenEstimate).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("keeps every chunk within the limit for a single enormous paragraph", () => {
    const huge = doc([body(paragraph("h", 800), 0)]);
    const chunks = chunkDocument(huge, { maxTokens: 300, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(300);
  });

  it("splits a single sentence with no boundaries by words", () => {
    const run = doc([body(Array.from({ length: 600 }, (_, i) => `word${i}`).join(" "), 0)]);
    const chunks = chunkDocument(run, { maxTokens: 120, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(120);
  });

  it("splits one unbroken string with no spaces", () => {
    const solid = doc([body("x".repeat(5000), 0)]);
    const chunks = chunkDocument(solid, { maxTokens: 100, overlapTokens: 10 });
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(100);
  });

  it("uses the PRD defaults of 1500 and 150 tokens", () => {
    const chunks = chunkDocument(bigDocument(3, 5, 60));
    for (const chunk of chunks) expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(1500);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("rejects unusable options", () => {
    const d = bigDocument(1, 1, 3);
    expect(() => chunkDocument(d, { maxTokens: 10 })).toThrow();
    expect(() => chunkDocument(d, { maxTokens: 300, overlapTokens: 200 })).toThrow();
    expect(() => chunkDocument(d, { maxTokens: 300, overlapTokens: -1 })).toThrow();
  });
});

describe("chunkDocument locators", () => {
  it("gives every chunk at least one locator", () => {
    const chunks = chunkDocument(bigDocument(8, 3, 25), { maxTokens: 250, overlapTokens: 25 });
    for (const chunk of chunks) expect(chunk.locators.length).toBeGreaterThanOrEqual(1);
  });

  it("only uses locators that exist in the source", () => {
    const source = bigDocument(5, 3, 20);
    const known = new Set(
      source.segments.map((s) => `${s.locator.kind}:${s.locator.start}:${s.locator.end}`),
    );
    for (const chunk of chunkDocument(source, { maxTokens: 250, overlapTokens: 25 })) {
      for (const l of chunk.locators) expect(known.has(`${l.kind}:${l.start}:${l.end}`)).toBe(true);
    }
  });

  it("does not repeat a locator inside one chunk", () => {
    const chunks = chunkDocument(doc([body(paragraph("d", 400), 0)]), {
      maxTokens: 200,
      overlapTokens: 20,
    });
    for (const chunk of chunks) {
      const keys = chunk.locators.map((l) => `${l.kind}:${l.start}:${l.end}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("keeps PDF page numbers on chunks", async () => {
    const pdf = makePdf([
      ["Evaporation", "The sun warms the sea. Vapor rises."],
      ["Condensation", "Vapor cools and forms clouds."],
      ["Precipitation", "Rain falls from heavy clouds."],
    ]);
    const source = await extractSourceDocument({ fileName: "a.pdf", data: pdf });
    const [only] = chunkDocument(source);
    expect(only.locators.map((l) => l.start).sort()).toEqual([1, 2, 3]);
    expect(only.locators.every((l) => l.kind === "page")).toBe(true);
  });
});

describe("chunkDocument structure", () => {
  it("packs small sections into one chunk and keeps their headings in the text", () => {
    const source = extractPlainText(
      "# Evaporation\n\nHeat makes vapor.\n\n# Condensation\n\nVapor cools.\n\n# Rain\n\nDroplets fall.",
      "md",
    );
    const chunks = chunkDocument(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].headings).toEqual(["Evaporation", "Condensation", "Rain"]);
    expect(chunks[0].text).toContain("# Condensation");
    expect(chunks[0].text).toContain("Vapor cools.");
  });

  it("starts a new chunk at a heading when the next section would not fit", () => {
    const source = bigDocument(4, 1, 25);
    const chunks = chunkDocument(source, { maxTokens: 300, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.startsWith("## Section")).toBe(true);
  });

  it("repeats the section heading on every continuation chunk", () => {
    const source = doc([heading("Big Topic", 0), body(paragraph("c", 300), 20)]);
    const chunks = chunkDocument(source, { maxTokens: 300, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(chunk.text.startsWith("## Big Topic")).toBe(true);
      expect(chunk.headings).toEqual(["Big Topic"]);
    }
  });

  it("starts continuation chunks with the tail of the previous chunk", () => {
    const source = doc([
      heading("Topic", 0),
      ...Array.from({ length: 12 }, (_, i) => body(paragraph(`o${i}x`, 6), 10 + i * 500)),
    ]);
    const chunks = chunkDocument(source, { maxTokens: 300, overlapTokens: 80 });
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const previousSentences = chunks[i - 1].text.split(/(?<=\.)\s+/);
      const lastOfPrevious = previousSentences[previousSentences.length - 1];
      expect(chunks[i].text).toContain(lastOfPrevious);
    }
  });

  it("has no overlap when the overlap budget is zero", () => {
    const source = doc([body(paragraph("z", 400), 0)]);
    const chunks = chunkDocument(source, { maxTokens: 200, overlapTokens: 0 });
    const seen = new Set<string>();
    for (const chunk of chunks) {
      for (const sentence of chunk.text.split(/(?<=\.)\s+/)) {
        expect(seen.has(sentence)).toBe(false);
        seen.add(sentence);
      }
    }
  });

  it("covers every sentence of the source", () => {
    const source = bigDocument(5, 3, 20);
    const chunks = chunkDocument(source, { maxTokens: 400, overlapTokens: 40 });
    const all = chunks.map((c) => c.text).join("\n");
    for (const segment of source.segments) {
      if (segment.heading) {
        expect(all).toContain(segment.text);
        continue;
      }
      for (const sentence of segment.text.split(/(?<=\.)\s+/)) expect(all).toContain(sentence);
    }
  });

  it("handles a document with no headings", () => {
    const source = doc([body(paragraph("n", 10), 0), body(paragraph("m", 10), 700)]);
    const chunks = chunkDocument(source, { maxTokens: 150, overlapTokens: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.headings).toEqual([]);
  });

  it("keeps a heading that has no body", () => {
    const source = doc([heading("Lonely heading", 0)]);
    const chunks = chunkDocument(source);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("## Lonely heading");
    expect(chunks[0].locators).toHaveLength(1);
  });

  it("numbers chunks from zero with stable ids", () => {
    const chunks = chunkDocument(bigDocument(4, 2, 30), { maxTokens: 250, overlapTokens: 25 });
    chunks.forEach((chunk, i) => {
      expect(chunk.index).toBe(i);
      expect(chunk.id).toBe(`chunk_${i}`);
    });
  });

  it("is deterministic", () => {
    const source = bigDocument(5, 3, 25);
    const options = { maxTokens: 300, overlapTokens: 30 };
    expect(chunkDocument(source, options)).toEqual(chunkDocument(source, options));
  });

  it("produces chunks that pass the schema", () => {
    for (const chunk of chunkDocument(bigDocument(3, 3, 25), {
      maxTokens: 300,
      overlapTokens: 30,
    })) {
      expect(Chunk.safeParse(chunk).success).toBe(true);
    }
  });
});

describe("estimateTokens", () => {
  it("is about one token per four characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
