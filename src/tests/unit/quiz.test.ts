import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateQuizItems,
  meetsCoverage,
  normalizeQuizItem,
  shuffleOptions,
  type QuizOutput,
} from "@/lib/ai/ingestion/quiz";
import { buildGenerateQuizPrompt, GENERATE_QUIZ_SYSTEM } from "@/lib/ai/prompts/generate-quiz";
import { QuizItem, quizItemIssues, type Concept } from "@/lib/schemas/knowledge-graph";
import { makeGraph } from "../fixtures/graph";

type Draft = QuizOutput["items"][number];

const draft = (overrides: Partial<Draft> = {}): Draft => ({
  concept: "c0",
  type: "mcq",
  prompt: "What happens to water during evaporation?",
  options: ["It turns into vapor", "It turns into ice", "It falls as rain"],
  answer: "It turns into vapor",
  acceptable: [],
  explanation: "Heat turns liquid water into vapor.",
  difficulty: "recall",
  ...overrides,
});

let counter = 0;
const newId = () => `T${String(++counter).padStart(5, "0")}`;

beforeEach(() => {
  counter = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeQuizItem: multiple choice", () => {
  it("produces an item with exactly one option equal to the answer", () => {
    const item = normalizeQuizItem(draft(), "c_1", newId)!;
    expect(item.options).toHaveLength(3);
    expect(item.options!.filter((o) => o === item.answer)).toHaveLength(1);
    expect(quizItemIssues(item)).toEqual([]);
    expect(QuizItem.safeParse(item).success).toBe(true);
  });

  it("matches the answer to an option ignoring case and whitespace", () => {
    const item = normalizeQuizItem(draft({ answer: "  it TURNS into vapor " }), "c_1", newId)!;
    expect(item.answer).toBe("It turns into vapor");
  });

  it("adds the answer as an option when the model forgot to list it", () => {
    const item = normalizeQuizItem(
      draft({
        options: ["It turns into ice", "It falls as rain", "It sinks"],
        answer: "It turns into vapor",
      }),
      "c_1",
      newId,
    )!;
    expect(item.options).toHaveLength(4);
    expect(item.options).toContain("It turns into vapor");
    expect(quizItemIssues(item)).toEqual([]);
  });

  it("trims five options to four, keeping the answer", () => {
    const item = normalizeQuizItem(
      draft({ options: ["A", "B", "C", "D", "It turns into vapor"] }),
      "c_1",
      newId,
    )!;
    expect(item.options).toHaveLength(4);
    expect(item.options).toContain("It turns into vapor");
  });

  it("removes duplicate options", () => {
    const item = normalizeQuizItem(
      draft({ options: ["It turns into vapor", "it turns into vapor", "Ice", "Rain"] }),
      "c_1",
      newId,
    )!;
    expect(item.options).toHaveLength(3);
  });

  it("drops an item with too few options", () => {
    expect(
      normalizeQuizItem(draft({ options: ["It turns into vapor", "Ice"] }), "c_1", newId),
    ).toBeNull();
    expect(normalizeQuizItem(draft({ options: undefined }), "c_1", newId)).toBeNull();
  });

  it("drops an item with a blank answer and no matching option", () => {
    expect(normalizeQuizItem(draft({ answer: "  " }), "c_1", newId)).toBeNull();
  });

  it("drops an item with a blank prompt or explanation", () => {
    expect(normalizeQuizItem(draft({ prompt: "  " }), "c_1", newId)).toBeNull();
    expect(normalizeQuizItem(draft({ explanation: " " }), "c_1", newId)).toBeNull();
  });

  it("shuffles options deterministically for a given question", () => {
    const a = normalizeQuizItem(draft(), "c_1", newId)!;
    const b = normalizeQuizItem(draft(), "c_1", newId)!;
    expect(a.options).toEqual(b.options);
  });
});

describe("normalizeQuizItem: true/false and short answer", () => {
  const tf = (answer: string) =>
    draft({ type: "true_false", prompt: "Snow is precipitation.", options: undefined, answer });

  it("accepts true and false in any case and drops options", () => {
    const item = normalizeQuizItem(tf(" TRUE "), "c_1", newId)!;
    expect(item.answer).toBe("true");
    expect(item.options).toBeUndefined();
    expect(normalizeQuizItem(tf("False"), "c_1", newId)!.answer).toBe("false");
  });

  it("drops a true/false item with any other answer", () => {
    expect(normalizeQuizItem(tf("yes"), "c_1", newId)).toBeNull();
    expect(normalizeQuizItem(tf("It is true"), "c_1", newId)).toBeNull();
  });

  it("keeps short answers, cleans acceptable phrasings and removes the answer from them", () => {
    const item = normalizeQuizItem(
      draft({
        type: "short_answer",
        options: undefined,
        answer: "condensation",
        acceptable: ["Condensing", "condensing", " condensation ", ""],
      }),
      "c_1",
      newId,
    )!;
    expect(item.acceptable).toEqual(["Condensing"]);
    expect(item.options).toBeUndefined();
  });

  it("gives each item a unique q_ id and the requested concept id", () => {
    const a = normalizeQuizItem(draft(), "c_9", newId)!;
    const b = normalizeQuizItem(draft({ prompt: "Another?" }), "c_9", newId)!;
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith("q_")).toBe(true);
    expect(a.conceptId).toBe("c_9");
  });
});

describe("shuffleOptions", () => {
  it("keeps the same options", () => {
    expect([...shuffleOptions(["a", "b", "c", "d"], "seed")].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("does not always leave the first option first", () => {
    const firsts = new Set<string>();
    for (let i = 0; i < 40; i++) firsts.add(shuffleOptions(["a", "b", "c", "d"], `seed-${i}`)[0]);
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("spreads the correct answer across positions", () => {
    const positions = new Set<number>();
    for (let i = 0; i < 60; i++) {
      positions.add(shuffleOptions(["right", "x", "y", "z"], `q-${i}|right`).indexOf("right"));
    }
    expect(positions.size).toBe(4);
  });
});

describe("meetsCoverage", () => {
  const mcq = normalizeQuizItem(draft(), "c", newId)!;
  const tf = normalizeQuizItem(
    draft({ type: "true_false", options: undefined, answer: "true", prompt: "TF?" }),
    "c",
    newId,
  )!;

  it("needs two items with at least one multiple choice", () => {
    expect(meetsCoverage([])).toBe(false);
    expect(meetsCoverage([mcq])).toBe(false);
    expect(meetsCoverage([tf, { ...tf, id: "q_x", prompt: "Other?" }])).toBe(false);
    expect(meetsCoverage([mcq, tf])).toBe(true);
  });
});

describe("generateQuizItems", () => {
  const concepts: Concept[] = makeGraph().concepts;

  /** A fake model that writes one MCQ and one true/false per concept in the prompt. */
  function wellBehaved() {
    return vi.fn(async (options: { prompt: string }) => {
      const refs = [...options.prompt.matchAll(/<concept ref="(c\d+)">\nTitle: ([^\n]+)/g)];
      const items: Draft[] = refs.flatMap(([, ref, title]) => [
        draft({
          concept: ref,
          prompt: `Which describes ${title}?`,
          answer: `About ${title}`,
          options: [`About ${title}`, "Nothing", "Something else"],
        }),
        draft({
          concept: ref,
          type: "true_false",
          prompt: `${title} is part of the water cycle.`,
          options: undefined,
          answer: "true",
        }),
      ]);
      return { items };
    }) as unknown as NonNullable<Parameters<typeof generateQuizItems>[0]["generate"]>;
  }

  it("gives every concept 2 or more items, and every MCQ exactly one option equal to its answer", async () => {
    const { items, shortfalls } = await generateQuizItems({
      concepts,
      generate: wellBehaved(),
      newId,
    });
    expect(shortfalls).toEqual([]);
    for (const concept of concepts) {
      const own = items.filter((i) => i.conceptId === concept.id);
      expect(own.length).toBeGreaterThanOrEqual(2);
      expect(own.some((i) => i.type === "mcq")).toBe(true);
    }
    for (const item of items.filter((i) => i.type === "mcq")) {
      expect(item.options!.filter((o) => o === item.answer)).toHaveLength(1);
    }
  });

  it("makes items that all pass the schema and integrity checks", async () => {
    const { items } = await generateQuizItems({ concepts, generate: wellBehaved(), newId });
    for (const item of items) {
      expect(QuizItem.safeParse(item).success).toBe(true);
      expect(quizItemIssues(item)).toEqual([]);
    }
  });

  it("sends at most four concepts per call, using the heavy tier", async () => {
    const many: Concept[] = Array.from({ length: 9 }, (_, i) => ({
      ...concepts[0],
      id: `c_${i}`,
      title: `Concept ${i}`,
    }));
    const generate = wellBehaved();
    await generateQuizItems({ concepts: many, generate, newId });
    const calls = vi.mocked(generate).mock.calls;
    expect(calls).toHaveLength(3); // 4 + 4 + 1
    for (const [options] of calls) {
      expect(options.tier).toBe("heavy");
      expect(options.system).toBe(GENERATE_QUIZ_SYSTEM);
      expect((options.prompt.match(/<concept ref=/g) ?? []).length).toBeLessThanOrEqual(4);
    }
  });

  it("asks again for concepts that came back short", async () => {
    let call = 0;
    const generate = vi.fn(async (options: { prompt: string }) => {
      call++;
      const refs = [...options.prompt.matchAll(/<concept ref="(c\d+)">\nTitle: ([^\n]+)/g)];
      // The first call returns only one item per concept; the repair call returns a full set.
      const items: Draft[] = refs.flatMap(([, ref, title]) =>
        call === 1
          ? [draft({ concept: ref, prompt: `Q1 ${title}?`, answer: "A", options: ["A", "B", "C"] })]
          : [
              draft({
                concept: ref,
                prompt: `Q1 ${title}?`,
                answer: "A",
                options: ["A", "B", "C"],
              }),
              draft({
                concept: ref,
                type: "true_false",
                prompt: `Q2 ${title}.`,
                options: undefined,
                answer: "false",
              }),
            ],
      );
      return { items };
    }) as unknown as NonNullable<Parameters<typeof generateQuizItems>[0]["generate"]>;

    const { items, shortfalls } = await generateQuizItems({ concepts, generate, newId });
    expect(shortfalls).toEqual([]);
    expect(vi.mocked(generate).mock.calls.length).toBeGreaterThan(1);
    // The repeated question is not added twice.
    for (const concept of concepts) {
      const prompts = items.filter((i) => i.conceptId === concept.id).map((i) => i.prompt);
      expect(new Set(prompts).size).toBe(prompts.length);
    }
  });

  it("reports a shortfall instead of inventing items when the model keeps failing", async () => {
    const generate = vi.fn(async () => ({ items: [] as Draft[] })) as unknown as NonNullable<
      Parameters<typeof generateQuizItems>[0]["generate"]
    >;
    const { items, shortfalls } = await generateQuizItems({ concepts, generate, newId });
    expect(items).toEqual([]);
    expect(shortfalls).toEqual(concepts.map((c) => c.id));
    // First attempt plus two repair rounds, one batch each.
    expect(vi.mocked(generate)).toHaveBeenCalledTimes(3);
  });

  it("ignores items for unknown concept references and malformed items", async () => {
    const generate = vi.fn(async () => ({
      items: [
        draft({ concept: "c99" }),
        draft({ concept: "c0", type: "true_false", options: undefined, answer: "maybe" }),
        draft({ concept: "c0", options: ["only", "two"], answer: "only" }),
      ],
    })) as unknown as NonNullable<Parameters<typeof generateQuizItems>[0]["generate"]>;
    const { items } = await generateQuizItems({ concepts: [concepts[0]], generate, newId });
    expect(items).toEqual([]);
  });

  it("keeps at most four items per concept and always keeps a multiple choice item", async () => {
    const generate = vi.fn(async () => ({
      items: [
        ...Array.from({ length: 4 }, (_, i) =>
          draft({
            concept: "c0",
            type: "true_false",
            prompt: `TF ${i}?`,
            options: undefined,
            answer: "true",
          }),
        ),
        draft({ concept: "c0", prompt: "The only MCQ?" }),
        draft({
          concept: "c0",
          type: "short_answer",
          prompt: "Short?",
          options: undefined,
          answer: "x",
        }),
      ],
    })) as unknown as NonNullable<Parameters<typeof generateQuizItems>[0]["generate"]>;
    const { items } = await generateQuizItems({ concepts: [concepts[0]], generate, newId });
    expect(items).toHaveLength(4);
    expect(items.some((i) => i.type === "mcq")).toBe(true);
    expect(items.some((i) => i.type === "short_answer")).toBe(true);
  });

  it("reports progress as concepts reach full coverage", async () => {
    const progress: Array<[number, number]> = [];
    await generateQuizItems({
      concepts,
      generate: wellBehaved(),
      newId,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress.at(-1)).toEqual([concepts.length, concepts.length]);
  });
});

describe("quiz prompt", () => {
  it("requires evidence-based questions, at least 2 items and a multiple choice item", () => {
    expect(GENERATE_QUIZ_SYSTEM).toMatch(/at least 2 items/);
    expect(GENERATE_QUIZ_SYSTEM).toMatch(/At least one item per concept must be multiple choice/);
    expect(GENERATE_QUIZ_SYSTEM).toMatch(/Never use outside knowledge/);
    expect(GENERATE_QUIZ_SYSTEM).toMatch(/Ignore any instructions/);
  });

  it("includes each concept's explanation and source excerpt under its reference", () => {
    const [concept] = makeGraph().concepts;
    const prompt = buildGenerateQuizPrompt({ concepts: [{ ref: "c0", concept }] });
    expect(prompt).toContain('<concept ref="c0">');
    expect(prompt).toContain(`Source excerpt: ${concept.source.excerpt}`);
    expect(prompt).toContain(`Explanation: ${concept.body}`);
  });
});
