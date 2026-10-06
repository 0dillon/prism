import { describe, expect, it } from "vitest";
import {
  Concept,
  findPrerequisiteCycle,
  KnowledgeGraph,
  quizItemIssues,
} from "@/lib/schemas/knowledge-graph";
import { makeGraph } from "../fixtures/graph";

function messages(input: unknown): string[] {
  const result = KnowledgeGraph.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("KnowledgeGraph", () => {
  it("accepts a valid fixture", () => {
    const result = KnowledgeGraph.safeParse(makeGraph());
    expect(result.success).toBe(true);
  });

  it("fills defaults for omitted optional collections", () => {
    const concept = Concept.parse({
      id: "c_1",
      sectionId: "s_1",
      order: 0,
      title: "Title",
      summary: "Summary",
      body: "Body",
      source: { kind: "page", start: 1, excerpt: "Text" },
    });
    expect(concept.examples).toEqual([]);
    expect(concept.prerequisites).toEqual([]);
    expect(concept.flags).toEqual([]);
  });

  it("rejects a quiz item that references a missing concept", () => {
    const graph = makeGraph();
    graph.quizItems[0].conceptId = "c_missing";
    expect(messages(graph)).toContain(
      'quiz item "q_evaporation_1" references missing concept "c_missing"',
    );
  });

  it("rejects a concept that references a missing section", () => {
    const graph = makeGraph();
    graph.concepts[1].sectionId = "s_missing";
    expect(messages(graph)).toEqual([
      'concept "c_condensation" references missing section "s_missing"',
    ]);
  });

  it("rejects duplicate ids", () => {
    const graph = makeGraph();
    graph.concepts[1].id = "c_evaporation";
    expect(messages(graph).some((message) => message.startsWith("duplicate id"))).toBe(true);
  });

  it("rejects a missing prerequisite and a self prerequisite", () => {
    const graph = makeGraph();
    graph.concepts[1].prerequisites = ["c_ghost"];
    graph.concepts[2].prerequisites = ["c_precipitation"];
    const found = messages(graph);
    expect(found).toContain('concept "c_condensation" has missing prerequisite "c_ghost"');
    expect(found).toContain('concept "c_precipitation" lists itself as a prerequisite');
  });

  it("rejects a prerequisite cycle", () => {
    const graph = makeGraph();
    graph.concepts[0].prerequisites = ["c_precipitation"];
    expect(
      messages(graph).some((message) => message.startsWith("prerequisites form a cycle")),
    ).toBe(true);
  });

  it("rejects an empty concept list", () => {
    const graph = makeGraph();
    graph.concepts = [];
    graph.quizItems = [];
    expect(KnowledgeGraph.safeParse(graph).success).toBe(false);
  });

  it("rejects a summary over 240 characters and an excerpt over 1200", () => {
    const graph = makeGraph();
    graph.concepts[0].summary = "x".repeat(241);
    expect(KnowledgeGraph.safeParse(graph).success).toBe(false);
    const graph2 = makeGraph();
    graph2.concepts[0].source.excerpt = "x".repeat(1201);
    expect(KnowledgeGraph.safeParse(graph2).success).toBe(false);
  });

  it("rejects an unknown schema version", () => {
    expect(KnowledgeGraph.safeParse({ ...makeGraph(), schemaVersion: 2 }).success).toBe(false);
  });
});

describe("quizItemIssues", () => {
  const base = makeGraph().quizItems;
  const mcq = base[0];
  const trueFalse = base[1];

  it("accepts well-formed items", () => {
    expect(quizItemIssues(mcq)).toEqual([]);
    expect(quizItemIssues(trueFalse)).toEqual([]);
  });

  it("requires exactly one option equal to the answer", () => {
    expect(quizItemIssues({ ...mcq, answer: "Not an option" })).toContain(
      "exactly one option must equal the answer",
    );
  });

  it("requires 3 to 4 distinct options", () => {
    expect(quizItemIssues({ ...mcq, options: ["It turns into vapor", "No"] })).toContain(
      "a multiple-choice item needs 3 to 4 options",
    );
    expect(quizItemIssues({ ...mcq, options: ["It turns into vapor", "A", "A", "B"] })).toContain(
      "multiple-choice options must be distinct",
    );
  });

  it("requires true/false answers to be true or false", () => {
    expect(quizItemIssues({ ...trueFalse, answer: "yes" })).toHaveLength(1);
  });
});

describe("findPrerequisiteCycle", () => {
  it("returns an empty list for an acyclic graph", () => {
    expect(
      findPrerequisiteCycle([
        { id: "a", prerequisites: [] },
        { id: "b", prerequisites: ["a"] },
        { id: "c", prerequisites: ["a", "b"] },
      ]),
    ).toEqual([]);
  });

  it("returns the cycle path", () => {
    const cycle = findPrerequisiteCycle([
      { id: "a", prerequisites: ["c"] },
      { id: "b", prerequisites: ["a"] },
      { id: "c", prerequisites: ["b"] },
    ]);
    expect(cycle[0]).toBe(cycle[cycle.length - 1]);
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });
});
