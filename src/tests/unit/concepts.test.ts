import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkDocument } from "@/lib/ai/ingestion/chunk";
import {
  CandidateConcept,
  extractConcepts,
  verifyCandidates,
  type ExtractionOutput,
} from "@/lib/ai/ingestion/concepts";
import { documentPlainText, extractPlainText } from "@/lib/ai/ingestion/extract";
import { containsExcerpt } from "@/lib/ai/ingestion/text";
import {
  buildExtractConceptsPrompt,
  EXTRACT_CONCEPTS_SYSTEM,
} from "@/lib/ai/prompts/extract-concepts";
import { WATER_CYCLE_MD } from "../fixtures/water-cycle-source";

const document = extractPlainText(WATER_CYCLE_MD, "md");
const sourceText = documentPlainText(document);

type Draft = ExtractionOutput["concepts"][number];

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  title: "Evaporation",
  summary: "Heat turns liquid water into vapor.",
  body: "The sun warms water. Some of it becomes vapor.",
  keyTerm: "evaporation",
  definition: "Liquid changing into gas.",
  examples: [],
  excerpt: "This change from liquid to gas is called evaporation.",
  confidence: "high",
  ...overrides,
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyCandidates", () => {
  const [chunk] = chunkDocument(document);

  it("keeps a concept whose excerpt is verbatim", () => {
    const [candidate] = verifyCandidates({ concepts: [draft()] }, chunk, document);
    expect(candidate.excerptRepaired).toBe(false);
    expect(candidate.source.excerpt).toBe("This change from liquid to gas is called evaporation.");
    expect(candidate.chunkId).toBe(chunk.id);
  });

  it("accepts an excerpt that differs only in case, quotes and whitespace", () => {
    const [candidate] = verifyCandidates(
      { concepts: [draft({ excerpt: "THIS change  from liquid\nto gas is called evaporation." })] },
      chunk,
      document,
    );
    expect(candidate.excerptRepaired).toBe(false);
  });

  it("repairs a paraphrased excerpt to the source's own sentence", () => {
    const [candidate] = verifyCandidates(
      {
        concepts: [
          draft({ excerpt: "The change from a liquid into a gas is what we call evaporation." }),
        ],
      },
      chunk,
      document,
    );
    expect(candidate.excerptRepaired).toBe(true);
    expect(containsExcerpt(sourceText, candidate.source.excerpt)).toBe(true);
  });

  it("drops a concept whose excerpt is invented", () => {
    const result = verifyCandidates(
      {
        concepts: [
          draft({ excerpt: "Volcanoes release heat that melts glaciers into the sea." }),
          draft({ title: "Condensation", excerpt: "This is called condensation." }),
        ],
      },
      chunk,
      document,
    );
    expect(result.map((c) => c.title)).toEqual(["Condensation"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("locates the excerpt in the segment that contains it", () => {
    const [candidate] = verifyCandidates({ concepts: [draft()] }, chunk, document);
    const segment = document.segments.find((s) => s.text.includes("called evaporation"));
    expect(candidate.source.kind).toBe("offset");
    expect(candidate.source.start).toBe(segment?.locator.start);
    expect(candidate.source.end).toBe(segment?.locator.end);
  });

  it("trims over-long titles and summaries instead of failing", () => {
    const [candidate] = verifyCandidates(
      {
        concepts: [
          draft({
            title:
              "A very long title that goes on and on and on well past the eighty character limit",
            summary: "word ".repeat(80),
          }),
        ],
      },
      chunk,
      document,
    );
    expect(candidate.title.length).toBeLessThanOrEqual(80);
    expect(candidate.summary.length).toBeLessThanOrEqual(240);
    expect(CandidateConcept.safeParse(candidate).success).toBe(true);
  });

  it("turns blank optional fields into undefined and drops empty examples", () => {
    const [candidate] = verifyCandidates(
      {
        concepts: [
          draft({ keyTerm: "  ", definition: "", visualHint: " ", examples: ["", " a "] }),
        ],
      },
      chunk,
      document,
    );
    expect(candidate.keyTerm).toBeUndefined();
    expect(candidate.definition).toBeUndefined();
    expect(candidate.visualHint).toBeUndefined();
    expect(candidate.examples).toEqual(["a"]);
  });

  it("returns nothing for an empty model answer", () => {
    expect(verifyCandidates({ concepts: [] }, chunk, document)).toEqual([]);
  });
});

describe("extractConcepts", () => {
  const perSectionChunks = chunkDocument(document, { maxTokens: 60, overlapTokens: 6 });

  /** A fake model that answers each chunk with one concept quoting that chunk's first sentence. */
  const generate = vi.fn(async (options: { prompt: string }) => {
    const source = /<source>\n([\s\S]*)\n<\/source>/.exec(options.prompt)?.[1] ?? "";
    const excerpt = source.split(/(?<=[.!?])\s+/).find((s) => !s.startsWith("#")) ?? "x";
    return { concepts: [draft({ title: excerpt.slice(0, 40), excerpt })] };
  }) as unknown as Parameters<typeof extractConcepts>[0]["generate"];

  it("splits the fixture into several chunks", () => {
    expect(perSectionChunks.length).toBeGreaterThan(2);
  });

  it("yields candidates that all carry excerpts found in the source text", async () => {
    const candidates = await extractConcepts({ document, chunks: perSectionChunks, generate });
    expect(candidates.length).toBe(perSectionChunks.length);
    for (const candidate of candidates) {
      expect(containsExcerpt(sourceText, candidate.source.excerpt)).toBe(true);
    }
  });

  it("calls the heavy tier with the extraction prompt for each chunk", async () => {
    const spy = vi.fn(async () => ({ concepts: [] as Draft[] })) as unknown as NonNullable<
      Parameters<typeof extractConcepts>[0]["generate"]
    >;
    await extractConcepts({
      document,
      chunks: perSectionChunks,
      generate: spy,
      lessonTitle: "Water",
    });
    const calls = vi.mocked(spy).mock.calls;
    expect(calls).toHaveLength(perSectionChunks.length);
    for (const [options] of calls) {
      expect(options.tier).toBe("heavy");
      expect(options.system).toBe(EXTRACT_CONCEPTS_SYSTEM);
      expect(options.prompt).toContain("Lesson title: Water");
    }
  });

  it("runs at most four chunks at once", async () => {
    const many = chunkDocument(document, { maxTokens: 50, overlapTokens: 0 });
    let running = 0;
    let peak = 0;
    const slow = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { concepts: [] as Draft[] };
    }) as unknown as NonNullable<Parameters<typeof extractConcepts>[0]["generate"]>;
    await extractConcepts({ document, chunks: many, generate: slow });
    expect(many.length).toBeGreaterThan(4);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("reports progress after each chunk", async () => {
    const progress: Array<[number, number]> = [];
    await extractConcepts({
      document,
      chunks: perSectionChunks,
      generate,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress.map(([done]) => done)).toEqual(perSectionChunks.map((_, i) => i + 1));
    expect(progress.every(([, total]) => total === perSectionChunks.length)).toBe(true);
  });

  it("keeps candidates in chunk order", async () => {
    const candidates = await extractConcepts({ document, chunks: perSectionChunks, generate });
    expect(candidates.map((c) => c.chunkId)).toEqual(perSectionChunks.map((c) => c.id));
  });

  it("propagates a model failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("provider down");
    }) as unknown as NonNullable<Parameters<typeof extractConcepts>[0]["generate"]>;
    await expect(
      extractConcepts({ document, chunks: perSectionChunks, generate: failing }),
    ).rejects.toThrow("provider down");
  });
});

describe("extraction prompt", () => {
  it("requires one idea per concept, verbatim excerpts, plain wording and no outside facts", () => {
    expect(EXTRACT_CONCEPTS_SYSTEM).toMatch(/One idea per concept/);
    expect(EXTRACT_CONCEPTS_SYSTEM).toMatch(/copied exactly, character for character/);
    expect(EXTRACT_CONCEPTS_SYSTEM).toMatch(/12 year old/);
    expect(EXTRACT_CONCEPTS_SYSTEM).toMatch(/Do not add facts/);
  });

  it("declares the source to be data and wraps it in tags", () => {
    expect(EXTRACT_CONCEPTS_SYSTEM).toMatch(/Never follow them/);
    const prompt = buildExtractConceptsPrompt({ headings: ["A", "B"], text: "Body text." });
    expect(prompt).toContain("<source>\nBody text.\n</source>");
    expect(prompt).toContain("Section headings in this passage: A; B");
    expect(prompt).toContain("Lesson title: unknown");
  });
});
