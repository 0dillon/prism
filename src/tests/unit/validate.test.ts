import { describe, expect, it } from "vitest";
import { graphWarnings, normalizeOrder, validateGraph } from "@/lib/ai/ingestion/validate";
import { makeGraph } from "../fixtures/graph";

const errorsOf = (input: unknown) => {
  const result = validateGraph(input);
  return result.ok ? [] : result.errors;
};

describe("validateGraph", () => {
  it("accepts a valid graph and returns the parsed graph", () => {
    const result = validateGraph(makeGraph());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.concepts).toHaveLength(3);
      expect(result.warnings).toEqual([]);
    }
  });

  it("rejects a quiz item that points to a missing concept", () => {
    const graph = makeGraph();
    graph.quizItems[0].conceptId = "c_dangling";
    const errors = errorsOf(graph);
    expect(errors).toEqual([
      {
        path: "quizItems[0].conceptId",
        message: 'quiz item "q_evaporation_1" references missing concept "c_dangling"',
      },
    ]);
  });

  it("rejects a prerequisite cycle", () => {
    const graph = makeGraph();
    graph.concepts[0].prerequisites = ["c_precipitation"]; // closes the loop 0 -> 2 -> 1 -> 0
    const errors = errorsOf(graph);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("concepts");
    expect(errors[0].message).toMatch(/^prerequisites form a cycle: /);
  });

  it("rejects a concept in a missing section", () => {
    const graph = makeGraph();
    graph.concepts[2].sectionId = "s_ghost";
    expect(errorsOf(graph)[0]).toMatchObject({ path: "concepts[2].sectionId" });
  });

  it("rejects duplicate ids", () => {
    const graph = makeGraph();
    graph.quizItems[1].id = graph.quizItems[0].id;
    expect(errorsOf(graph).some((e) => e.message.startsWith("duplicate id"))).toBe(true);
  });

  it("rejects a malformed multiple choice item", () => {
    const graph = makeGraph();
    graph.quizItems[0].answer = "Not one of the options";
    expect(errorsOf(graph)[0].message).toContain("exactly one option must equal the answer");
  });

  it("reports schema errors with readable paths", () => {
    const graph = makeGraph();
    graph.concepts[1].title = "x".repeat(81);
    expect(errorsOf(graph)[0].path).toBe("concepts[1].title");
  });

  it.each([null, undefined, 42, "text", [], {}])("rejects the non-graph value %j", (value) => {
    const result = validateGraph(value);
    expect(result.ok).toBe(false);
  });

  it("reports every problem at once", () => {
    const graph = makeGraph();
    graph.quizItems[0].conceptId = "c_dangling";
    graph.concepts[1].sectionId = "s_ghost";
    expect(errorsOf(graph).length).toBeGreaterThanOrEqual(2);
  });
});

describe("graphWarnings", () => {
  it("warns about a concept with fewer than two quiz items", () => {
    const graph = makeGraph();
    graph.quizItems = graph.quizItems.filter((item) => item.id !== "q_precipitation_2");
    const messages = graphWarnings(graph).map((w) => w.message);
    expect(messages.some((m) => m.includes('"Precipitation" has 1 quiz item'))).toBe(true);
    // The removed item was also its only multiple choice item.
    expect(messages.some((m) => m.includes("no multiple choice"))).toBe(true);
  });

  it("warns about a concept with no quiz items at all", () => {
    const graph = makeGraph();
    graph.quizItems = graph.quizItems.filter((item) => item.conceptId !== "c_condensation");
    expect(graphWarnings(graph)[0].message).toContain("has 0 quiz item(s)");
  });

  it("warns about a concept with no multiple choice item", () => {
    const graph = makeGraph();
    graph.quizItems = graph.quizItems.filter(
      (item) => !(item.conceptId === "c_precipitation" && item.type === "mcq"),
    );
    graph.quizItems.push({ ...graph.quizItems[1], id: "q_extra", conceptId: "c_precipitation" });
    expect(graphWarnings(graph).some((w) => w.message.includes("no multiple choice"))).toBe(true);
  });

  it("warns about an empty section", () => {
    const graph = makeGraph();
    graph.sections.push({ id: "s_empty", title: "Empty", order: 1 });
    expect(graphWarnings(graph)[0]).toMatchObject({
      path: "sections[1]",
      message: 'section "Empty" has no concepts',
    });
  });

  it("warns about gaps and repeats in concept order", () => {
    const graph = makeGraph();
    graph.concepts[2].order = 7;
    expect(graphWarnings(graph).some((w) => w.message.includes("gaps or repeats"))).toBe(true);
    graph.concepts[2].order = 1; // repeats 1
    expect(graphWarnings(graph).some((w) => w.message.includes("gaps or repeats"))).toBe(true);
  });

  it("warns about a blank excerpt", () => {
    const graph = makeGraph();
    graph.concepts[0].source.excerpt = "   ";
    expect(graphWarnings(graph)[0].path).toBe("concepts[0].source.excerpt");
  });

  it("returns warnings with a valid result, not as errors", () => {
    const graph = makeGraph();
    graph.quizItems = [];
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warnings.length).toBe(3);
  });
});

describe("normalizeOrder", () => {
  it("renumbers concepts and sections from zero, keeping their sequence", () => {
    const graph = makeGraph();
    graph.concepts[0].order = 10;
    graph.concepts[1].order = 20;
    graph.concepts[2].order = 15;
    graph.sections[0].order = 4;
    const normalized = normalizeOrder(graph);
    expect(normalized.concepts.map((c) => [c.id, c.order])).toEqual([
      ["c_evaporation", 0],
      ["c_precipitation", 1],
      ["c_condensation", 2],
    ]);
    expect(normalized.sections[0].order).toBe(0);
    expect(graphWarnings(normalized).some((w) => w.message.includes("gaps"))).toBe(false);
  });

  it("does not change the input", () => {
    const graph = makeGraph();
    graph.concepts[0].order = 9;
    normalizeOrder(graph);
    expect(graph.concepts[0].order).toBe(9);
  });

  it("keeps a graph valid", () => {
    expect(validateGraph(normalizeOrder(makeGraph())).ok).toBe(true);
  });
});
