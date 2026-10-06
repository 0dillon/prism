import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StructuredOutputError } from "@/lib/ai/llm";
import { runIngestion, userFacingError } from "@/lib/ai/ingestion/pipeline";
import { INGESTION_STAGES } from "@/lib/ai/ingestion/stages";
import { ExtractionError } from "@/lib/ai/ingestion/types";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { createFakeLlm } from "../fixtures/fake-llm";
import { MemoryStore } from "../fixtures/memory-store";
import { makePdf } from "../fixtures/pdf";
import { WATER_CYCLE_MD } from "../fixtures/water-cycle-source";

const encode = (text: string) => new TextEncoder().encode(text);

function setup(fileName = "water.md", data: Uint8Array = encode(WATER_CYCLE_MD)) {
  const store = new MemoryStore();
  const path = `user/lesson/source.${fileName.split(".").pop()}`;
  store.files.set(path, data);
  let counter = 0;
  const newId = () => `ID${String(++counter).padStart(6, "0")}`;
  const input = (extra: Record<string, unknown> = {}) => ({
    jobId: "job-1",
    lessonId: "lesson-1",
    sourcePath: path,
    fileName,
    store,
    newId,
    ...extra,
  });
  return { store, input };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("runIngestion: upload to needs_review", () => {
  it("takes a fixture from upload to needs_review with a valid graph", async () => {
    const { store, input } = setup();
    const llm = createFakeLlm();
    const result = await runIngestion(
      input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0],
    );

    expect(result.status).toBe("needs_review");
    expect(store.lessonStatus).toBe("needs_review");
    expect(store.statusHistory).toEqual(["processing", "needs_review"]);
    expect(store.job.stage).toBe("ready");
    expect(store.job.progress).toBe(100);
    expect(store.error).toBeNull();

    // The saved draft is a complete, valid Knowledge Graph.
    const draft = store.draft!;
    expect(KnowledgeGraph.safeParse(draft.graph).success).toBe(true);
    expect(draft.graph.lessonId).toBe("lesson-1");
    expect(draft.title).toBe("The Water Cycle");
    expect(draft.graph.concepts.length).toBeGreaterThanOrEqual(3);
  });

  it("gives every concept at least two quiz items with a multiple choice item", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    const { concepts, quizItems } = store.draft!.graph;
    for (const concept of concepts) {
      const own = quizItems.filter((q) => q.conceptId === concept.id);
      expect(own.length).toBeGreaterThanOrEqual(2);
      expect(own.some((q) => q.type === "mcq")).toBe(true);
    }
  });

  it("links every concept to a verbatim source excerpt and a location", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    for (const concept of store.draft!.graph.concepts) {
      expect(WATER_CYCLE_MD.replace(/\s+/g, " ")).toContain(
        concept.source.excerpt.replace(/\s+/g, " "),
      );
      expect(concept.source.kind).toBe("offset");
    }
  });

  it("walks the stages in order with non-decreasing progress", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    const stages = store.updates.flatMap((u) => (u.stage ? [u.stage] : []));
    const firstSeen = [...new Set(stages)];
    const order = INGESTION_STAGES.filter((s) => firstSeen.includes(s));
    expect(firstSeen).toEqual(order);
    expect(firstSeen[0]).toBe("reading");
    expect(firstSeen.at(-1)).toBe("ready");
    const progress = store.updates.flatMap((u) => (u.progress !== undefined ? [u.progress] : []));
    for (const value of progress) expect(value).toBeGreaterThanOrEqual(0);
    for (const value of progress) expect(value).toBeLessThanOrEqual(100);
    // Sequential steps never move backwards (concurrent per-chunk updates can interleave, so check stage boundaries).
    const boundaries = INGESTION_STAGES.map((s) =>
      Math.max(...store.updates.filter((u) => u.stage === s).map((u) => u.progress ?? 0), -1),
    ).filter((v) => v >= 0);
    expect([...boundaries].sort((a, b) => a - b)).toEqual(boundaries);
  });

  it("records token usage on the job", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(store.job.tokensIn).toBeGreaterThan(0);
    expect(store.job.tokensOut).toBeGreaterThan(0);
  });

  it("uses the heavy tier for every step", async () => {
    const { input } = setup();
    const llm = createFakeLlm();
    await runIngestion(input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0]);
    expect(new Set(llm.calls.map((c) => c.name))).toEqual(
      new Set(["extract-concepts", "merge-concepts", "generate-quiz"]),
    );
    expect(llm.calls.every((c) => c.tier === "heavy")).toBe(true);
  });

  it("prefers a teacher-supplied title over the model's", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({ generate: createFakeLlm().generate, lessonTitle: "Mr Reyes: Water" }) as Parameters<
        typeof runIngestion
      >[0],
    );
    expect(store.draft!.graph.title).toBe("Mr Reyes: Water");
  });

  it("handles a PDF with page locators", async () => {
    const pdf = makePdf([
      ["Evaporation", "The sun warms water in oceans and lakes. Some of it turns into vapor."],
      [
        "Condensation",
        "Vapor cools high in the sky. It turns into tiny droplets that form clouds.",
      ],
    ]);
    const { store, input } = setup("lesson.pdf", pdf);
    // The fake model reads markdown headings, so give the PDF headings that look like markdown to it.
    const llm = createFakeLlm();
    const result = await runIngestion(
      input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("needs_review");
    for (const concept of store.draft!.graph.concepts) {
      expect(concept.source.kind).toBe("page");
      expect([1, 2]).toContain(concept.source.start);
    }
  });
});

describe("runIngestion: failures", () => {
  it("fails a file type that is not supported yet with a clear message", async () => {
    const { store, input } = setup("talk.mp3", encode("audio"));
    const result = await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result).toEqual({
      status: "failed",
      stage: "reading",
      error: "Audio files are not supported yet.",
    });
    expect(store.lessonStatus).toBe("failed");
    expect(store.error).toBe("Audio files are not supported yet.");
    expect(store.draft).toBeNull();
  });

  it("fails an empty file", async () => {
    const { store, input } = setup("empty.txt", new Uint8Array(0));
    const result = await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("failed");
    expect(store.lessonStatus).toBe("failed");
  });

  it("fails when no concepts can be extracted", async () => {
    const { store, input } = setup();
    const llm = createFakeLlm({ emptyFor: ["extract-concepts"] });
    const result = await runIngestion(
      input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("failed");
    expect(store.error).toMatch(/No concepts could be extracted/);
  });

  it("does not leak internal error details to the teacher", async () => {
    const { store, input } = setup();
    const llm = createFakeLlm({
      failAlways: { "merge-concepts": new Error("401 key sk-secret-123 rejected") },
    });
    const result = await runIngestion(
      input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result).toMatchObject({ status: "failed", stage: "merging" });
    expect(store.error).not.toContain("sk-secret");
    expect(store.error).toMatch(/Something went wrong/);
  });

  it("explains an unusable AI result", async () => {
    const { store, input } = setup();
    const llm = createFakeLlm({
      failAlways: { "generate-quiz": new StructuredOutputError("generate-quiz", "bad", 2) },
    });
    await runIngestion(input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0]);
    expect(store.error).toMatch(/AI could not produce a usable result/);
    expect(store.job.stage).toBe("generating_quizzes");
  });

  it("still reports the failure when the database is down", async () => {
    const { store, input } = setup("talk.mp3", encode("audio"));
    store.failWrites = true;
    const result = await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("failed");
  });

  it("completes with warnings, not failure, when a concept ends up short of quiz items", async () => {
    const { store, input } = setup();
    const llm = createFakeLlm({ emptyFor: ["generate-quiz"] });
    const result = await runIngestion(
      input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("needs_review");
    if (result.status === "needs_review") {
      expect(result.warnings.some((w) => w.message.includes("quiz item"))).toBe(true);
    }
    expect(store.draft!.graph.quizItems).toEqual([]);
  });
});

describe("runIngestion: resuming", () => {
  it("resumes from the failed step without repeating finished ones", async () => {
    const { store, input } = setup();

    // First run: the quiz step fails.
    const failing = createFakeLlm({
      failAlways: { "generate-quiz": new Error("provider outage") },
    });
    const first = await runIngestion(
      input({ generate: failing.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(first).toMatchObject({ status: "failed", stage: "generating_quizzes" });
    expect(store.lessonStatus).toBe("failed");
    expect(Object.keys(store.job.artifacts).sort()).toEqual([
      "candidates",
      "chunks",
      "merged",
      "source",
    ]);
    const extractionCalls = failing.countOf("extract-concepts");
    expect(extractionCalls).toBeGreaterThan(0);

    // Second run: a healthy model. Extraction and merge must not be called again.
    const healthy = createFakeLlm();
    const second = await runIngestion(
      input({ generate: healthy.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(second.status).toBe("needs_review");
    if (second.status === "needs_review") {
      expect(second.resumedSteps).toEqual(["source", "chunks", "candidates", "merged"]);
    }
    expect(healthy.countOf("extract-concepts")).toBe(0);
    expect(healthy.countOf("merge-concepts")).toBe(0);
    expect(healthy.countOf("generate-quiz")).toBeGreaterThan(0);
    expect(store.downloads).toHaveLength(1); // the file is read once
    expect(store.lessonStatus).toBe("needs_review");
    expect(store.error).toBeNull();
  });

  it("keeps the concepts it extracted before the failure", async () => {
    const { store, input } = setup();
    const failing = createFakeLlm({ failAlways: { "merge-concepts": new Error("outage") } });
    await runIngestion(input({ generate: failing.generate }) as Parameters<typeof runIngestion>[0]);
    expect(store.job.artifacts.candidates?.length).toBeGreaterThanOrEqual(3);
    expect(store.job.artifacts.merged).toBeUndefined();
  });

  it("adds token usage across runs instead of resetting it", async () => {
    const { store, input } = setup();
    const failing = createFakeLlm({ failAlways: { "generate-quiz": new Error("outage") } });
    await runIngestion(input({ generate: failing.generate }) as Parameters<typeof runIngestion>[0]);
    const afterFirst = store.job.tokensIn;
    expect(afterFirst).toBeGreaterThan(0);
    await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(store.job.tokensIn).toBeGreaterThan(afterFirst);
  });

  it("re-runs a step whose saved output no longer matches its schema", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({
        generate: createFakeLlm({ failAlways: { "generate-quiz": new Error("x") } }).generate,
      }) as Parameters<typeof runIngestion>[0],
    );
    // Corrupt the saved candidates, as an old schema version might.
    (store.job.artifacts as Record<string, unknown>).candidates = [{ nonsense: true }];
    const healthy = createFakeLlm();
    const result = await runIngestion(
      input({ generate: healthy.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("needs_review");
    expect(healthy.countOf("extract-concepts")).toBeGreaterThan(0);
  });

  it("is safe to run again after success: finished steps are all reused", async () => {
    const { store, input } = setup();
    await runIngestion(
      input({ generate: createFakeLlm().generate }) as Parameters<typeof runIngestion>[0],
    );
    const again = createFakeLlm();
    const result = await runIngestion(
      input({ generate: again.generate }) as Parameters<typeof runIngestion>[0],
    );
    expect(result.status).toBe("needs_review");
    expect(again.calls).toHaveLength(0);
    expect(store.downloads).toHaveLength(1);
  });
});

describe("runIngestion: sign tagging", () => {
  const run = (
    store: MemoryStore,
    input: ReturnType<typeof setup>["input"],
    llm = createFakeLlm(),
  ) => runIngestion(input({ generate: llm.generate }) as Parameters<typeof runIngestion>[0]);

  it("proposes links for key terms that match the library, and saves them", async () => {
    const { store, input } = setup();
    store.glosses = [{ id: "clip-evap", gloss: "evaporation" }];
    const result = await run(store, input);
    expect(result.status).toBe("needs_review");
    const evaporation = store.draft!.graph.concepts.find((c) => c.keyTerm === "evaporation")!;
    expect(store.signLinks).toEqual([{ conceptId: evaporation.id, signClipId: "clip-evap" }]);
    expect(store.job.artifacts.signs).toHaveLength(1);
  });

  it("links only terms whose gloss exists, never inventing one", async () => {
    const { store, input } = setup();
    store.glosses = [{ id: "clip-evap", gloss: "evaporation" }];
    await run(store, input);
    expect(store.signLinks).toHaveLength(1);
    expect(store.signLinks.every((l) => l.signClipId === "clip-evap")).toBe(true);
  });

  it("does not fail the lesson when the sign library cannot be read", async () => {
    const { store, input } = setup();
    store.glossError = new Error("library down");
    const result = await run(store, input);
    expect(result.status).toBe("needs_review");
    expect(store.signLinks).toEqual([]);
  });

  it("does not fail the lesson when the sign model call fails", async () => {
    const { store, input } = setup();
    store.glosses = [{ id: "clip-x", gloss: "unrelated" }];
    const llm = createFakeLlm({ failAlways: { "match-signs": new Error("model down") } });
    expect((await run(store, input, llm)).status).toBe("needs_review");
  });

  it("skips the step on resume once it has run", async () => {
    const { store, input } = setup();
    await run(store, input);
    const again = await run(store, input);
    expect(again.status === "needs_review" && again.resumedSteps.includes("signs")).toBe(true);
  });
});

describe("userFacingError", () => {
  it("passes extraction errors through, since they are written for people", () => {
    expect(userFacingError(new ExtractionError("The PDF has no text layer."))).toBe(
      "The PDF has no text layer.",
    );
  });

  it("hides everything else", () => {
    expect(userFacingError(new Error("ECONNRESET 10.0.0.4:5432"))).toMatch(/Something went wrong/);
    expect(userFacingError("string")).toMatch(/Something went wrong/);
  });
});
