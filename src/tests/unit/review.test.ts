import { describe, expect, it } from "vitest";
import {
  addConcept,
  addQuizItem,
  applyEditedFlags,
  canMove,
  convertQuizType,
  deleteConcept,
  deleteQuizItem,
  describeLocator,
  flaggedConceptIds,
  hasProblems,
  markChecked,
  mergeIntoPrevious,
  moveConcept,
  orderedConcepts,
  quizItemProblems,
  quizItemsFor,
  updateConcept,
  updateQuizItem,
  updateSectionTitle,
} from "@/lib/ai/ingestion/review";
import { validateGraph } from "@/lib/ai/ingestion/validate";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { makeGraph } from "../fixtures/graph";

const titles = (graph: KnowledgeGraph) => orderedConcepts(graph).map((c) => c.title);
const orders = (graph: KnowledgeGraph) => orderedConcepts(graph).map((c) => c.order);

/** The fixture graph with a second section so cross-section moves can be tested. */
function twoSections(): KnowledgeGraph {
  const graph = makeGraph();
  graph.sections.push({ id: "s_2", title: "Falling water", order: 1 });
  graph.concepts[2].sectionId = "s_2";
  return graph;
}

describe("immutability", () => {
  it.each([
    ["updateConcept", (g: KnowledgeGraph) => updateConcept(g, "c_evaporation", { title: "X" })],
    ["deleteConcept", (g: KnowledgeGraph) => deleteConcept(g, "c_condensation")],
    ["moveConcept", (g: KnowledgeGraph) => moveConcept(g, "c_condensation", "up")],
    ["mergeIntoPrevious", (g: KnowledgeGraph) => mergeIntoPrevious(g, "c_condensation")],
    ["addConcept", (g: KnowledgeGraph) => addConcept(g, "s_1", "c_new")],
    ["markChecked", (g: KnowledgeGraph) => markChecked(g, "c_evaporation")],
    [
      "updateQuizItem",
      (g: KnowledgeGraph) => updateQuizItem(g, "q_evaporation_1", { prompt: "Q" }),
    ],
    ["deleteQuizItem", (g: KnowledgeGraph) => deleteQuizItem(g, "q_evaporation_1")],
    ["addQuizItem", (g: KnowledgeGraph) => addQuizItem(g, "c_evaporation", "q_new")],
  ])("%s does not change its input", (_name, edit) => {
    const graph = makeGraph();
    const snapshot = JSON.stringify(graph);
    edit(graph);
    expect(JSON.stringify(graph)).toBe(snapshot);
  });
});

describe("updateConcept and updateSectionTitle", () => {
  it("changes only the given fields of one concept", () => {
    const graph = updateConcept(makeGraph(), "c_condensation", {
      title: "Cloud formation",
      summary: "New.",
    });
    const concept = graph.concepts.find((c) => c.id === "c_condensation")!;
    expect(concept).toMatchObject({
      title: "Cloud formation",
      summary: "New.",
      id: "c_condensation",
    });
    expect(concept.body).toBe(makeGraph().concepts[1].body);
    expect(graph.concepts.find((c) => c.id === "c_evaporation")!.title).toBe("Evaporation");
  });

  it("keeps the concept id and source excerpt", () => {
    const graph = updateConcept(makeGraph(), "c_evaporation", { body: "Rewritten." });
    const concept = graph.concepts[0];
    expect(concept.id).toBe("c_evaporation");
    expect(concept.source.excerpt).toBe(makeGraph().concepts[0].source.excerpt);
  });

  it("renames a section", () => {
    expect(updateSectionTitle(makeGraph(), "s_1", "Renamed").sections[0].title).toBe("Renamed");
  });
});

describe("deleteConcept", () => {
  it("removes the concept, its quiz items and prerequisite links, and keeps order contiguous", () => {
    const graph = deleteConcept(makeGraph(), "c_condensation");
    expect(titles(graph)).toEqual(["Evaporation", "Precipitation"]);
    expect(orders(graph)).toEqual([0, 1]);
    expect(graph.quizItems.some((q) => q.conceptId === "c_condensation")).toBe(false);
    expect(graph.concepts.find((c) => c.id === "c_precipitation")!.prerequisites).toEqual([]);
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("removes a section that becomes empty", () => {
    const graph = deleteConcept(twoSections(), "c_precipitation");
    expect(graph.sections.map((s) => s.id)).toEqual(["s_1"]);
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("ignores an unknown id", () => {
    expect(titles(deleteConcept(makeGraph(), "nope"))).toEqual(titles(makeGraph()));
  });

  it("leaves other concepts' ids and progress keys untouched", () => {
    const graph = deleteConcept(makeGraph(), "c_evaporation");
    expect(graph.concepts.map((c) => c.id)).toEqual(["c_condensation", "c_precipitation"]);
  });
});

describe("moveConcept", () => {
  it("swaps a concept with its neighbor and renumbers", () => {
    const graph = moveConcept(makeGraph(), "c_condensation", "up");
    expect(titles(graph)).toEqual(["Condensation", "Evaporation", "Precipitation"]);
    expect(orders(graph)).toEqual([0, 1, 2]);
  });

  it("moves down too", () => {
    expect(titles(moveConcept(makeGraph(), "c_evaporation", "down"))).toEqual([
      "Condensation",
      "Evaporation",
      "Precipitation",
    ]);
  });

  it("does nothing at the ends", () => {
    const graph = makeGraph();
    expect(moveConcept(graph, "c_evaporation", "up")).toBe(graph);
    expect(moveConcept(graph, "c_precipitation", "down")).toBe(graph);
    expect(moveConcept(graph, "nope", "up")).toBe(graph);
  });

  it("moves a concept into the neighboring section when it crosses a boundary", () => {
    const graph = moveConcept(twoSections(), "c_precipitation", "up");
    expect(titles(graph)).toEqual(["Evaporation", "Precipitation", "Condensation"]);
    const moved = graph.concepts.find((c) => c.id === "c_precipitation")!;
    expect(moved.sectionId).toBe("s_1");
    // The section it left became empty only if it had one concept, so it is gone.
    expect(graph.sections.map((s) => s.id)).toEqual(["s_1"]);
  });

  it("keeps a valid graph through many moves", () => {
    let graph = twoSections();
    const plan: Array<[string, "up" | "down"]> = [
      ["c_precipitation", "up"],
      ["c_evaporation", "down"],
      ["c_condensation", "up"],
      ["c_evaporation", "down"],
    ];
    for (const [id, dir] of plan) {
      graph = moveConcept(graph, id, dir);
      expect(validateGraph(graph).ok).toBe(true);
      expect(orders(graph)).toEqual([0, 1, 2]);
    }
  });

  it("reports whether a move is possible", () => {
    const graph = makeGraph();
    expect(canMove(graph, "c_evaporation", "up")).toBe(false);
    expect(canMove(graph, "c_evaporation", "down")).toBe(true);
    expect(canMove(graph, "c_precipitation", "down")).toBe(false);
    expect(canMove(graph, "nope", "up")).toBe(false);
  });
});

describe("mergeIntoPrevious", () => {
  it("appends the text, carries over quiz items and removes the absorbed concept", () => {
    const original = makeGraph();
    const graph = mergeIntoPrevious(original, "c_condensation");
    expect(titles(graph)).toEqual(["Evaporation", "Precipitation"]);
    const keeper = graph.concepts.find((c) => c.id === "c_evaporation")!;
    expect(keeper.body).toContain(original.concepts[0].body);
    expect(keeper.body).toContain(original.concepts[1].body);
    expect(keeper.flags).toContain("edited");
    expect(quizItemsFor(graph, "c_evaporation")).toHaveLength(4);
    expect(quizItemsFor(graph, "c_condensation")).toHaveLength(0);
  });

  it("points prerequisites that named the absorbed concept at the keeper", () => {
    const graph = mergeIntoPrevious(makeGraph(), "c_condensation");
    expect(graph.concepts.find((c) => c.id === "c_precipitation")!.prerequisites).toEqual([
      "c_evaporation",
    ]);
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("combines examples without duplicates and keeps the keeper's key term", () => {
    const base = makeGraph();
    base.concepts[1].examples = ["A puddle that dries on a sunny day.", "Fog on a morning lake."];
    const graph = mergeIntoPrevious(base, "c_condensation");
    expect(graph.concepts[0].examples).toEqual([
      "A puddle that dries on a sunny day.",
      "Fog on a morning lake.",
    ]);
    expect(graph.concepts[0].keyTerm).toBe("evaporation");
  });

  it("does nothing for the first concept", () => {
    const graph = makeGraph();
    expect(mergeIntoPrevious(graph, "c_evaporation")).toBe(graph);
  });
});

describe("addConcept", () => {
  it("adds a blank concept at the end of the section and keeps the graph valid", () => {
    const graph = addConcept(twoSections(), "s_1", "c_new");
    expect(titles(graph)).toEqual(["Evaporation", "Condensation", "New concept", "Precipitation"]);
    expect(orders(graph)).toEqual([0, 1, 2, 3]);
    const created = graph.concepts.find((c) => c.id === "c_new")!;
    expect(created.sectionId).toBe("s_1");
    expect(created.flags).toEqual(["edited"]);
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.warnings.some((w) => w.message.includes("no source excerpt"))).toBe(true);
  });

  it("has no quiz items until the teacher adds them, and warns about it", () => {
    const result = validateGraph(addConcept(makeGraph(), "s_1", "c_new"));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.warnings.some((w) => w.message.includes('"New concept" has 0 quiz'))).toBe(
        true,
      );
  });
});

describe("flags", () => {
  const flagged = () => {
    const graph = makeGraph();
    graph.concepts[1].flags = ["low_confidence"];
    graph.concepts[2].flags = ["ungrounded", "edited"];
    graph.quizItems[0].flags = ["ungrounded"];
    return graph;
  };

  it("lists flagged concepts in teaching order", () => {
    expect(flaggedConceptIds(flagged())).toEqual(["c_condensation", "c_precipitation"]);
  });

  it("does not count 'edited' alone as a flag needing attention", () => {
    const graph = makeGraph();
    graph.concepts[0].flags = ["edited"];
    expect(flaggedConceptIds(graph)).toEqual([]);
  });

  it("markChecked clears attention flags on the concept and its quiz items but keeps 'edited'", () => {
    const graph = markChecked(flagged(), "c_precipitation");
    expect(graph.concepts.find((c) => c.id === "c_precipitation")!.flags).toEqual(["edited"]);
    expect(flaggedConceptIds(graph)).toEqual(["c_condensation"]);
    const base = flagged();
    base.quizItems[0].conceptId = "c_precipitation";
    expect(markChecked(base, "c_precipitation").quizItems[0].flags).toEqual([]);
  });
});

describe("quiz item editing", () => {
  it("updates a multiple choice item and keeps it valid", () => {
    const graph = updateQuizItem(makeGraph(), "q_evaporation_1", {
      prompt: "What does heat do to liquid water?",
      options: ["It makes vapor", "It makes ice", "It makes clouds"],
      answer: "It makes vapor",
    });
    expect(validateGraph(graph).ok).toBe(true);
    expect(graph.quizItems[0].prompt).toBe("What does heat do to liquid water?");
  });

  it("surfaces an invalid edit through validation instead of hiding it", () => {
    const graph = updateQuizItem(makeGraph(), "q_evaporation_1", { answer: "Not an option" });
    const result = validateGraph(graph);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors[0].message).toContain("exactly one option must equal the answer");
  });

  it("drops options when a multiple choice item becomes true/false", () => {
    const graph = updateQuizItem(makeGraph(), "q_evaporation_1", {
      type: "true_false",
      answer: "true",
    });
    expect(graph.quizItems[0].options).toBeUndefined();
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("deletes an item", () => {
    const graph = deleteQuizItem(makeGraph(), "q_evaporation_1");
    expect(graph.quizItems.some((q) => q.id === "q_evaporation_1")).toBe(false);
    expect(graph.quizItems).toHaveLength(5);
  });

  it("adds a valid multiple choice item to a concept", () => {
    const graph = addQuizItem(makeGraph(), "c_precipitation", "q_new");
    const item = graph.quizItems.find((q) => q.id === "q_new")!;
    expect(item).toMatchObject({ conceptId: "c_precipitation", type: "mcq", flags: ["edited"] });
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("finds a concept's items", () => {
    expect(quizItemsFor(makeGraph(), "c_condensation").map((q) => q.id)).toEqual([
      "q_condensation_1",
      "q_condensation_2",
    ]);
  });
});

describe("applyEditedFlags", () => {
  it("flags only the concepts and items whose content changed", () => {
    const before = makeGraph();
    let after = updateConcept(before, "c_condensation", { summary: "A new summary." });
    after = updateQuizItem(after, "q_evaporation_2", { explanation: "Because the sun heats it." });
    const flagged = applyEditedFlags(before, after);
    expect(flagged.concepts.map((c) => c.flags.includes("edited"))).toEqual([false, true, false]);
    expect(flagged.quizItems.filter((q) => q.flags.includes("edited")).map((q) => q.id)).toEqual([
      "q_evaporation_2",
    ]);
  });

  it("flags new concepts and items", () => {
    const before = makeGraph();
    const after = addQuizItem(addConcept(before, "s_1", "c_new"), "c_new", "q_new");
    const flagged = applyEditedFlags(before, after);
    expect(flagged.concepts.find((c) => c.id === "c_new")!.flags).toContain("edited");
    expect(flagged.quizItems.find((q) => q.id === "q_new")!.flags).toContain("edited");
  });

  it("does not flag a reorder, a prerequisite change or a flag change", () => {
    const before = makeGraph();
    const after = moveConcept(before, "c_condensation", "up");
    expect(applyEditedFlags(before, after).concepts.some((c) => c.flags.includes("edited"))).toBe(
      false,
    );
  });

  it("does not duplicate the flag", () => {
    const before = makeGraph();
    const after = updateConcept(before, "c_evaporation", { title: "Changed" });
    const once = applyEditedFlags(before, after);
    const twice = applyEditedFlags(before, once);
    expect(twice.concepts[0].flags.filter((f) => f === "edited")).toHaveLength(1);
  });

  it("ignores a client that claims edits it did not make", () => {
    const before = makeGraph();
    const after = makeGraph();
    expect(applyEditedFlags(before, after).concepts.some((c) => c.flags.includes("edited"))).toBe(
      false,
    );
  });
});

describe("describeLocator", () => {
  it("describes pages, recordings and plain text", () => {
    expect(describeLocator({ kind: "page", start: 3 })).toBe("Page 3");
    expect(describeLocator({ kind: "time", start: 125 })).toBe("2:05 in the recording");
    expect(describeLocator({ kind: "offset", start: 500 })).toBe("Your text");
  });
});

describe("convertQuizType", () => {
  const mcq = () => makeGraph().quizItems[0];
  const tf = () => makeGraph().quizItems[1];
  const short = () => makeGraph().quizItems[3];

  it("returns nothing when the type is unchanged", () => {
    expect(convertQuizType(mcq(), "mcq")).toEqual({});
  });

  it("makes true/false from multiple choice, dropping options", () => {
    const graph = updateQuizItem(makeGraph(), mcq().id, convertQuizType(mcq(), "true_false"));
    expect(graph.quizItems[0]).toMatchObject({
      type: "true_false",
      answer: "true",
      acceptable: [],
    });
    expect(graph.quizItems[0].options).toBeUndefined();
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("makes multiple choice from true/false with a valid starter set of options", () => {
    const graph = updateQuizItem(makeGraph(), tf().id, convertQuizType(tf(), "mcq"));
    expect(graph.quizItems[1].options).toHaveLength(3);
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("uses a short answer's text as the correct option when it becomes multiple choice", () => {
    const patch = convertQuizType(short(), "mcq");
    expect(patch.options).toContain("condensation");
    expect(patch.answer).toBe("condensation");
  });

  it("keeps existing options when converting to multiple choice and back", () => {
    const toShort = convertQuizType(mcq(), "short_answer");
    expect(toShort).toMatchObject({ type: "short_answer", answer: mcq().answer });
    expect(toShort.options).toBeUndefined();
  });

  it("clears the answer when a true/false item becomes short answer", () => {
    expect(convertQuizType(tf(), "short_answer").answer).toBe("");
  });

  it("every conversion between every pair of types produces a valid item once a short answer is filled in", () => {
    const types = ["mcq", "true_false", "short_answer"] as const;
    for (const from of types) {
      for (const to of types) {
        const start = makeGraph().quizItems.find((q) => q.type === from)!;
        const patch = convertQuizType(start, to);
        const graph = updateQuizItem(
          makeGraph(),
          start.id,
          patch.answer === "" ? { ...patch, answer: "water" } : patch,
        );
        expect(validateGraph(graph).ok, `${from} -> ${to}`).toBe(true);
      }
    }
  });
});

describe("quizItemProblems", () => {
  const item = () => ({
    ...makeGraph().quizItems[0],
    options: [...makeGraph().quizItems[0].options!],
  });

  it("reports nothing for a good item", () => {
    expect(quizItemProblems(item())).toEqual({});
    expect(hasProblems(quizItemProblems(item()))).toBe(false);
  });

  it("flags a blank question and explanation", () => {
    expect(quizItemProblems({ ...item(), prompt: " ", explanation: "" })).toMatchObject({
      prompt: expect.any(String),
      explanation: expect.any(String),
    });
  });

  it("flags blank and repeated options individually", () => {
    const problems = quizItemProblems({ ...item(), options: ["A", "", "a", "D"], answer: "A" });
    expect(problems.options?.[0]).toBeUndefined();
    expect(problems.options?.[1]).toMatch(/Write this option/);
    expect(problems.options?.[2]).toMatch(/repeats/);
    expect(problems.options?.[3]).toBeUndefined();
  });

  it("flags too few or too many options", () => {
    expect(quizItemProblems({ ...item(), options: ["A", "B"], answer: "A" }).optionSet).toMatch(
      /at least 3/,
    );
    expect(
      quizItemProblems({ ...item(), options: ["A", "B", "C", "D", "E"], answer: "A" }).optionSet,
    ).toMatch(/at most 4/);
  });

  it("flags a missing correct option", () => {
    expect(quizItemProblems({ ...item(), answer: "Nothing like this" }).answer).toMatch(
      /Choose which option/,
    );
  });

  it("checks true/false and short answer answers", () => {
    const base = makeGraph().quizItems;
    expect(quizItemProblems({ ...base[1], answer: "maybe" }).answer).toMatch(/true or false/);
    expect(quizItemProblems({ ...base[3], answer: "  " }).answer).toMatch(/model answer/);
    expect(hasProblems(quizItemProblems(base[1]))).toBe(false);
  });

  it("agrees with the schema: an item with no problems passes validation", () => {
    for (const q of makeGraph().quizItems) expect(hasProblems(quizItemProblems(q))).toBe(false);
  });
});
