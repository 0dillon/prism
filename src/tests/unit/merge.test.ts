import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateConcept } from "@/lib/ai/ingestion/concepts";
import {
  assembleMergedParts,
  createIdFactory,
  mergeConcepts,
  type MergeOutput,
} from "@/lib/ai/ingestion/merge";
import { ExtractionError } from "@/lib/ai/ingestion/types";
import { buildMergeConceptsPrompt, MERGE_CONCEPTS_SYSTEM } from "@/lib/ai/prompts/merge-concepts";
import {
  Concept,
  graphIntegrityIssues,
  findPrerequisiteCycle,
} from "@/lib/schemas/knowledge-graph";

function candidate(title: string, overrides: Partial<CandidateConcept> = {}): CandidateConcept {
  return {
    chunkId: "chunk_0",
    title,
    summary: `${title} summary.`,
    body: `${title} body.`,
    examples: [],
    confidence: "high",
    excerptRepaired: false,
    source: { kind: "page", start: 1, excerpt: `${title} excerpt.` },
    ...overrides,
  };
}

const five = () => ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((t) => candidate(t));

const proposal = (overrides: Partial<MergeOutput> = {}): MergeOutput => ({
  title: "A Lesson",
  overview: "What it covers.",
  sections: [
    { title: "First", concepts: ["r0", "r1"] },
    { title: "Second", concepts: ["r2", "r3", "r4"] },
  ],
  duplicates: [],
  prerequisites: [],
  ...overrides,
});

let counter = 0;
const sequentialIds = () => `ID${String(++counter).padStart(4, "0")}`;

beforeEach(() => {
  counter = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("assembleMergedParts invariants", () => {
  it("gives every concept and section a unique id", () => {
    const parts = assembleMergedParts(five(), proposal());
    const ids = [...parts.concepts.map((c) => c.id), ...parts.sections.map((s) => s.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(parts.concepts.every((c) => c.id.startsWith("c_"))).toBe(true);
    expect(parts.sections.every((s) => s.id.startsWith("s_"))).toBe(true);
  });

  it("numbers concepts 0..n-1 contiguously across sections, in section order", () => {
    const parts = assembleMergedParts(five(), proposal());
    expect(parts.concepts.map((c) => c.order)).toEqual([0, 1, 2, 3, 4]);
    expect(parts.concepts.map((c) => c.title)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
    expect(parts.sections.map((s) => s.order)).toEqual([0, 1]);
  });

  it("puts each concept in the section that listed it", () => {
    const parts = assembleMergedParts(five(), proposal());
    const sectionOf = (title: string) =>
      parts.sections.find((s) => s.id === parts.concepts.find((c) => c.title === title)?.sectionId)
        ?.title;
    expect(sectionOf("Alpha")).toBe("First");
    expect(sectionOf("Delta")).toBe("Second");
  });

  it("follows the model's teaching order even when it differs from extraction order", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({ sections: [{ title: "All", concepts: ["r4", "r2", "r0", "r1", "r3"] }] }),
    );
    expect(parts.concepts.map((c) => c.title)).toEqual([
      "Epsilon",
      "Gamma",
      "Alpha",
      "Beta",
      "Delta",
    ]);
  });

  it("builds parts that pass the knowledge graph integrity checks", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({
        prerequisites: [
          { concept: "r1", requires: ["r0"] },
          { concept: "r4", requires: ["r2", "r3"] },
        ],
      }),
    );
    expect(
      graphIntegrityIssues({ sections: parts.sections, concepts: parts.concepts, quizItems: [] }),
    ).toEqual([]);
    for (const concept of parts.concepts) expect(Concept.safeParse(concept).success).toBe(true);
  });

  it("is deterministic given an id factory", () => {
    counter = 0;
    const a = assembleMergedParts(five(), proposal(), { newId: sequentialIds });
    counter = 0;
    const b = assembleMergedParts(five(), proposal(), { newId: sequentialIds });
    expect(a).toEqual(b);
  });

  it("makes ids that sort in creation order", () => {
    const newId = createIdFactory();
    const ids = Array.from({ length: 50 }, () => newId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });
});

describe("prerequisites", () => {
  it("maps prerequisite refs to concept ids", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({ prerequisites: [{ concept: "r2", requires: ["r0", "r1"] }] }),
    );
    const byTitle = (t: string) => parts.concepts.find((c) => c.title === t)!;
    expect(byTitle("Gamma").prerequisites).toEqual([byTitle("Alpha").id, byTitle("Beta").id]);
  });

  it("removes a cycle the model proposed, in code", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({
        prerequisites: [
          { concept: "r0", requires: ["r2"] },
          { concept: "r1", requires: ["r0"] },
          { concept: "r2", requires: ["r1"] },
        ],
      }),
    );
    expect(findPrerequisiteCycle(parts.concepts)).toEqual([]);
    // Only the edge pointing to an earlier concept survives.
    const byTitle = (t: string) => parts.concepts.find((c) => c.title === t)!;
    expect(byTitle("Alpha").prerequisites).toEqual([]);
    expect(byTitle("Beta").prerequisites).toEqual([byTitle("Alpha").id]);
    expect(byTitle("Gamma").prerequisites).toEqual([byTitle("Beta").id]);
  });

  it("drops self references, unknown refs, forward refs and duplicates", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({
        prerequisites: [
          { concept: "r1", requires: ["r1", "r9", "r3", "r0", "r0"] },
          { concept: "r99", requires: ["r0"] },
        ],
      }),
    );
    const byTitle = (t: string) => parts.concepts.find((c) => c.title === t)!;
    expect(byTitle("Beta").prerequisites).toEqual([byTitle("Alpha").id]);
  });

  it("allows at most three prerequisites per concept", () => {
    const eight = Array.from({ length: 8 }, (_, i) => candidate(`C${i}`));
    const parts = assembleMergedParts(eight, {
      ...proposal(),
      sections: [{ title: "All", concepts: eight.map((_, i) => `r${i}`) }],
      prerequisites: [{ concept: "r7", requires: ["r0", "r1", "r2", "r3", "r4", "r5"] }],
    });
    expect(parts.concepts[7].prerequisites).toHaveLength(3);
  });

  it("never produces a cycle for random proposals", () => {
    const eight = Array.from({ length: 8 }, (_, i) => candidate(`C${i}`));
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let trial = 0; trial < 50; trial++) {
      const prerequisites = Array.from({ length: 12 }, () => ({
        concept: `r${Math.floor(random() * 8)}`,
        requires: [`r${Math.floor(random() * 8)}`, `r${Math.floor(random() * 8)}`],
      }));
      const order = eight.map((_, i) => `r${i}`).sort(() => random() - 0.5);
      const parts = assembleMergedParts(eight, {
        ...proposal(),
        sections: [{ title: "All", concepts: order }],
        prerequisites,
      });
      expect(findPrerequisiteCycle(parts.concepts)).toEqual([]);
    }
  });
});

describe("recovering from a poor proposal", () => {
  it("ignores unknown refs in sections", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({
        sections: [{ title: "All", concepts: ["r0", "r77", "ghost", "r1", "r2", "r3", "r4"] }],
      }),
    );
    expect(parts.concepts).toHaveLength(5);
  });

  it("places a concept the model listed twice only once", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({
        sections: [
          { title: "A", concepts: ["r0", "r1", "r2"] },
          { title: "B", concepts: ["r2", "r3", "r4"] },
        ],
      }),
    );
    expect(parts.concepts.map((c) => c.title)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
  });

  it("appends candidates the model forgot instead of losing them", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({ sections: [{ title: "Only", concepts: ["r0", "r1"] }] }),
    );
    expect(parts.concepts.map((c) => c.title)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
    ]);
    expect(parts.sections.map((s) => s.title)).toEqual(["Only", "More ideas"]);
  });

  it("organizes everything into one section when the model's sections are all invalid", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({ sections: [{ title: "Bad", concepts: ["x", "y"] }] }),
    );
    expect(parts.concepts).toHaveLength(5);
    expect(parts.sections).toHaveLength(1);
  });

  it("drops empty sections", () => {
    const parts = assembleMergedParts(
      five(),
      proposal({
        sections: [
          { title: "Empty", concepts: [] },
          { title: "Full", concepts: ["r0", "r1", "r2", "r3", "r4"] },
        ],
      }),
    );
    expect(parts.sections.map((s) => s.title)).toEqual(["Full"]);
  });

  it("clamps an over-long overview", () => {
    const parts = assembleMergedParts(five(), proposal({ overview: "word ".repeat(300) }));
    expect(parts.overview.length).toBeLessThanOrEqual(600);
  });
});

describe("duplicates", () => {
  it("merges an absorbed candidate into the one that is kept", () => {
    const cands = [
      candidate("Evaporation", { examples: ["A puddle drying"] }),
      candidate("Evaporating water", {
        examples: ["Wet laundry drying", "a puddle drying"],
        keyTerm: "evaporation",
      }),
      candidate("Rain"),
    ];
    const parts = assembleMergedParts(cands, {
      ...proposal(),
      sections: [{ title: "All", concepts: ["r0", "r2"] }],
      duplicates: [{ keep: "r0", absorbed: ["r1"] }],
    });
    expect(parts.concepts.map((c) => c.title)).toEqual(["Evaporation", "Rain"]);
    expect(parts.concepts[0].examples).toEqual(["A puddle drying", "Wet laundry drying"]);
    expect(parts.concepts[0].keyTerm).toBe("evaporation");
  });

  it("does not place an absorbed candidate even if a section lists it", () => {
    const cands = [candidate("A"), candidate("A again"), candidate("B")];
    const parts = assembleMergedParts(cands, {
      ...proposal(),
      sections: [{ title: "All", concepts: ["r0", "r1", "r2"] }],
      duplicates: [{ keep: "r0", absorbed: ["r1"] }],
    });
    expect(parts.concepts.map((c) => c.title)).toEqual(["A", "B"]);
  });

  it("redirects a prerequisite on an absorbed concept to the one that was kept", () => {
    const cands = [candidate("A"), candidate("A again"), candidate("B")];
    const parts = assembleMergedParts(cands, {
      ...proposal(),
      sections: [{ title: "All", concepts: ["r0", "r2"] }],
      duplicates: [{ keep: "r0", absorbed: ["r1"] }],
      prerequisites: [{ concept: "r2", requires: ["r1"] }],
    });
    expect(parts.concepts[1].prerequisites).toEqual([parts.concepts[0].id]);
  });

  it("never builds chains: a keeper cannot be absorbed, and self or unknown refs are ignored", () => {
    const cands = [candidate("A"), candidate("B"), candidate("C")];
    const parts = assembleMergedParts(cands, {
      ...proposal(),
      sections: [{ title: "All", concepts: ["r0", "r1", "r2"] }],
      duplicates: [
        { keep: "r0", absorbed: ["r0", "r1"] },
        { keep: "r1", absorbed: ["r2"] }, // r1 keeps its own group, so r0 cannot absorb it
        { keep: "r9", absorbed: ["r2"] },
      ],
    });
    expect(parts.concepts.map((c) => c.title)).toEqual(["A", "B"]); // C was folded into B
  });
});

describe("flags and fallbacks", () => {
  it("flags low confidence concepts and concepts with repaired excerpts", () => {
    const parts = assembleMergedParts(
      [
        candidate("Sure"),
        candidate("Unsure", { confidence: "low" }),
        candidate("Repaired", { excerptRepaired: true }),
      ],
      { ...proposal(), sections: [{ title: "All", concepts: ["r0", "r1", "r2"] }] },
    );
    expect(parts.concepts.map((c) => c.flags)).toEqual([
      [],
      ["low_confidence"],
      ["low_confidence"],
    ]);
  });

  it("uses the fallback title when the model's title is blank", () => {
    const parts = assembleMergedParts(five(), proposal({ title: "  " }), {
      fallbackTitle: "My Source",
    });
    expect(parts.title).toBe("My Source");
  });
});

describe("mergeConcepts", () => {
  const fakeGenerate = (output: MergeOutput) =>
    vi.fn(async () => output) as unknown as NonNullable<
      Parameters<typeof mergeConcepts>[0]["generate"]
    >;

  it("fails with a clear error when there are no candidates", async () => {
    await expect(mergeConcepts({ candidates: [] })).rejects.toThrow(ExtractionError);
  });

  it("skips the model for a single candidate", async () => {
    const generate = fakeGenerate(proposal());
    const parts = await mergeConcepts({
      candidates: [candidate("Only")],
      lessonTitle: "Solo",
      generate,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(parts.concepts).toHaveLength(1);
    expect(parts.title).toBe("Solo");
    expect(parts.sections).toHaveLength(1);
  });

  it("calls the heavy tier once with every candidate listed by reference", async () => {
    const generate = fakeGenerate(proposal());
    await mergeConcepts({ candidates: five(), lessonTitle: "Greek", generate });
    const calls = vi.mocked(generate).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].tier).toBe("heavy");
    expect(calls[0][0].system).toBe(MERGE_CONCEPTS_SYSTEM);
    for (let i = 0; i < 5; i++) expect(calls[0][0].prompt).toContain(`r${i} |`);
    expect(calls[0][0].prompt).toContain("Lesson title: Greek");
  });

  it("returns valid parts for a full proposal", async () => {
    const parts = await mergeConcepts({ candidates: five(), generate: fakeGenerate(proposal()) });
    expect(parts.concepts).toHaveLength(5);
    expect(
      graphIntegrityIssues({ sections: parts.sections, concepts: parts.concepts, quizItems: [] }),
    ).toEqual([]);
  });
});

describe("merge prompt", () => {
  it("tells the model to use references only, merge only true duplicates, and ignore embedded instructions", () => {
    expect(MERGE_CONCEPTS_SYSTEM).toMatch(/Never invent a reference/);
    expect(MERGE_CONCEPTS_SYSTEM).toMatch(/only true duplicates/);
    expect(MERGE_CONCEPTS_SYSTEM).toMatch(/Ignore any instructions/);
  });

  it("lists term and summary for each candidate", () => {
    const prompt = buildMergeConceptsPrompt({
      candidates: [candidate("Evaporation", { keyTerm: "evaporation" })],
    });
    expect(prompt).toContain("r0 | Evaporation | term: evaporation | Evaporation summary.");
  });
});
