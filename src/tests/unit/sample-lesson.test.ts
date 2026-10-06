import { describe, expect, it } from "vitest";
import {
  SAMPLE_GRAPH_VERSION,
  SAMPLE_LESSON,
  SAMPLE_LESSON_ID,
  SAMPLE_VARIANTS,
} from "@/lib/demo/sample-lesson";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";

describe("the demo lesson", () => {
  it("is a valid Knowledge Graph, so every layout can render it like a real lesson", () => {
    const result = KnowledgeGraph.safeParse(SAMPLE_LESSON);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("has the id and version the demo page uses", () => {
    expect(SAMPLE_LESSON.lessonId).toBe(SAMPLE_LESSON_ID);
    expect(SAMPLE_GRAPH_VERSION).toBe(1);
  });

  it("has two sections, so paging by section has something to page between", () => {
    expect(SAMPLE_LESSON.sections).toHaveLength(2);
    for (const section of SAMPLE_LESSON.sections) {
      expect(SAMPLE_LESSON.concepts.some((c) => c.sectionId === section.id)).toBe(true);
    }
  });

  it("has at least two questions for every idea, so a retry always has another to ask", () => {
    for (const concept of SAMPLE_LESSON.concepts) {
      expect(
        SAMPLE_LESSON.quizItems.filter((q) => q.conceptId === concept.id).length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses all three question types", () => {
    expect(new Set(SAMPLE_LESSON.quizItems.map((q) => q.type))).toEqual(
      new Set(["mcq", "true_false", "short_answer"]),
    );
  });

  it("has a key term and definition for every idea, for the sign and read-aloud layouts", () => {
    for (const concept of SAMPLE_LESSON.concepts) {
      expect(concept.keyTerm).toBeTruthy();
      expect(concept.definition).toBeTruthy();
    }
  });

  it("has a plain and a simple wording for every idea, and none for an idea that is not there", () => {
    expect(Object.keys(SAMPLE_VARIANTS).sort()).toEqual(
      SAMPLE_LESSON.concepts.map((c) => c.id).sort(),
    );
    for (const variant of Object.values(SAMPLE_VARIANTS)) {
      expect(variant.plain.length).toBeGreaterThan(40);
      expect(variant.simple.length).toBeGreaterThan(20);
      expect(variant.simple.length).toBeLessThan(variant.plain.length);
    }
  });

  it("names no condition anywhere", () => {
    expect(JSON.stringify({ SAMPLE_LESSON, SAMPLE_VARIANTS })).not.toMatch(
      /adhd|dyslex|autis|blind|deaf|disabilit/i,
    );
  });
});
