import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/http";
import {
  addConcept,
  deleteConcept,
  markChecked,
  moveConcept,
  updateConcept,
  updateQuizItem,
} from "@/lib/ai/ingestion/review";
import { saveReviewedGraph, MAX_GRAPH_BYTES, SaveGraphInput } from "@/lib/lessons/review-service";
import { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { FakeSupabase } from "../fixtures/fake-supabase";
import { makeGraph } from "../fixtures/graph";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let db: FakeSupabase;

const seed = (graph: KnowledgeGraph = makeGraph(), extra: Record<string, unknown> = {}) => {
  const lesson = db.seedLesson({
    owner_id: OWNER,
    status: "needs_review",
    graph,
    title: graph.title,
    updated_at: "2026-10-06T10:00:00.000Z",
    ...extra,
  });
  return { id: lesson.id as string, updatedAt: lesson.updated_at as string };
};

const save = (
  id: string,
  graph: unknown,
  expectedUpdatedAt = "2026-10-06T10:00:00.000Z",
  userId = OWNER,
) => saveReviewedGraph(db.asUser(userId), userId, id, { graph, expectedUpdatedAt });

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected a rejection");
};

const storedGraph = () => db.tables.lessons[0].graph as KnowledgeGraph;

beforeEach(() => {
  db = new FakeSupabase();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveReviewedGraph: saving edits", () => {
  it("saves an edited graph and returns it with the new version", async () => {
    const { id } = seed();
    const edited = updateConcept(makeGraph(), "c_condensation", { summary: "A clearer summary." });
    const saved = await save(id, edited);
    expect(saved.graph.concepts[1].summary).toBe("A clearer summary.");
    expect(saved.updatedAt).toBeTruthy();
    expect(storedGraph().concepts[1].summary).toBe("A clearer summary.");
    expect(KnowledgeGraph.safeParse(storedGraph()).success).toBe(true);
  });

  it("flags edited concepts and items itself", async () => {
    const { id } = seed();
    let edited = updateConcept(makeGraph(), "c_evaporation", { title: "Evaporating" });
    edited = updateQuizItem(edited, "q_precipitation_1", { explanation: "New explanation." });
    const saved = await save(id, edited);
    expect(saved.graph.concepts.map((c) => c.flags.includes("edited"))).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      saved.graph.quizItems.filter((q) => q.flags.includes("edited")).map((q) => q.id),
    ).toEqual(["q_precipitation_1"]);
  });

  it("keeps the lesson title in step with the graph title", async () => {
    const { id } = seed();
    await save(id, { ...makeGraph(), title: "A Better Title" });
    expect(db.tables.lessons[0].title).toBe("A Better Title");
  });

  it("saves deletions, reorders and additions, keeping order contiguous", async () => {
    const { id } = seed();
    let edited = deleteConcept(makeGraph(), "c_condensation");
    edited = moveConcept(edited, "c_precipitation", "up");
    edited = addConcept(edited, "s_1", "c_new");
    const saved = await save(id, edited);
    expect(saved.graph.concepts.map((c) => c.order)).toEqual([0, 1, 2]);
    expect(saved.graph.concepts.map((c) => c.id)).toEqual([
      "c_precipitation",
      "c_evaporation",
      "c_new",
    ]);
  });

  it("returns warnings for a graph that is valid but thin", async () => {
    const { id } = seed();
    const saved = await save(id, addConcept(makeGraph(), "s_1", "c_new"));
    expect(saved.warnings.some((w) => w.message.includes("no source excerpt"))).toBe(true);
  });

  it("renumbers a graph with gaps in its order", async () => {
    const { id } = seed();
    const gappy = makeGraph();
    gappy.concepts[0].order = 5;
    gappy.concepts[1].order = 9;
    gappy.concepts[2].order = 20;
    const saved = await save(id, gappy);
    expect(saved.graph.concepts.map((c) => c.order)).toEqual([0, 1, 2]);
  });
});

describe("saveReviewedGraph: what the client cannot change", () => {
  it("restores a concept's source excerpt and location", async () => {
    const { id } = seed();
    const forged = makeGraph();
    forged.concepts[0].source = {
      kind: "page",
      start: 99,
      excerpt: "Something the source never said.",
    };
    const saved = await save(id, forged);
    expect(saved.graph.concepts[0].source).toEqual(makeGraph().concepts[0].source);
  });

  it("ignores a changed lesson id", async () => {
    const { id } = seed();
    const saved = await save(id, { ...makeGraph(), lessonId: "someone_elses_lesson" });
    expect(saved.graph.lessonId).toBe(makeGraph().lessonId);
  });

  it("does not let a client add attention flags", async () => {
    const { id } = seed();
    const forged = makeGraph();
    forged.concepts[0].flags = ["ungrounded", "low_confidence"];
    forged.quizItems[0].flags = ["ungrounded"];
    const saved = await save(id, forged);
    expect(saved.graph.concepts[0].flags).toEqual([]);
    expect(saved.graph.quizItems[0].flags).toEqual([]);
  });

  it("lets a teacher clear attention flags by marking a concept checked", async () => {
    const flagged = makeGraph();
    flagged.concepts[1].flags = ["low_confidence"];
    flagged.quizItems[2].flags = ["ungrounded"];
    const { id } = seed(flagged);
    const saved = await save(id, markChecked(flagged, "c_condensation"));
    expect(saved.graph.concepts[1].flags).toEqual([]);
    expect(saved.graph.quizItems[2].flags).toEqual([]);
  });

  it("keeps attention flags the client leaves in place", async () => {
    const flagged = makeGraph();
    flagged.concepts[2].flags = ["ungrounded"];
    const { id } = seed(flagged);
    const saved = await save(id, flagged);
    expect(saved.graph.concepts[2].flags).toEqual(["ungrounded"]);
  });
});

describe("saveReviewedGraph: validation", () => {
  it("rejects a quiz item that points at a missing concept", async () => {
    const { id } = seed();
    const broken = makeGraph();
    broken.quizItems[0].conceptId = "c_ghost";
    const error = await rejection(save(id, broken));
    expect(error).toMatchObject({ status: 422, code: "invalid_graph" });
    expect(error.message).toContain("references missing concept");
    expect(storedGraph()).toEqual(makeGraph());
  });

  it("rejects a prerequisite cycle", async () => {
    const { id } = seed();
    const broken = makeGraph();
    broken.concepts[0].prerequisites = ["c_precipitation"];
    expect((await rejection(save(id, broken))).message).toContain("cycle");
  });

  it("rejects a malformed multiple choice item", async () => {
    const { id } = seed();
    const error = await rejection(
      save(id, updateQuizItem(makeGraph(), "q_evaporation_1", { answer: "None of these" })),
    );
    expect(error.message).toContain("exactly one option");
  });

  it.each([null, "text", 12, [], {}, { schemaVersion: 2 }])(
    "rejects a non-graph value %j",
    async (value) => {
      const { id } = seed();
      expect((await rejection(save(id, value))).status).toBe(422);
    },
  );

  it("rejects an enormous graph before parsing it", async () => {
    const { id } = seed();
    const huge = { ...makeGraph(), overview: "x".repeat(MAX_GRAPH_BYTES) };
    expect(await rejection(save(id, huge))).toMatchObject({ status: 413, code: "too_large" });
  });
});

describe("saveReviewedGraph: access and conflicts", () => {
  it("returns 404 for someone else's lesson and saves nothing", async () => {
    const { id } = seed();
    const error = await rejection(
      save(id, updateConcept(makeGraph(), "c_evaporation", { title: "Hacked" }), undefined, OTHER),
    );
    expect(error.status).toBe(404);
    expect(storedGraph().concepts[0].title).toBe("Evaporation");
  });

  it("returns 404 for a lesson that does not exist", async () => {
    expect(
      (await rejection(save("33333333-3333-4333-8333-333333333333", makeGraph()))).status,
    ).toBe(404);
  });

  it("refuses to edit a published lesson", async () => {
    const { id } = seed(makeGraph(), { status: "published" });
    expect(await rejection(save(id, makeGraph()))).toMatchObject({
      status: 409,
      code: "not_editable",
    });
  });

  it("refuses to edit a lesson still processing", async () => {
    const { id } = seed(makeGraph(), { status: "processing" });
    expect((await rejection(save(id, makeGraph()))).message).toMatch(/not ready for review/);
  });

  it("detects an edit made since the editor loaded", async () => {
    const { id } = seed();
    const error = await rejection(save(id, makeGraph(), "2026-10-06T09:00:00.000Z"));
    expect(error).toMatchObject({ status: 409, code: "conflict" });
  });

  it("detects a save that lands between the check and the write", async () => {
    const { id } = seed();
    // Another tab saves first: the stored version moves on after our read.
    const real = db.asUser(OWNER);
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop !== "from") return Reflect.get(target, prop);
        return (table: string) => {
          const builder = target.from(table as never) as unknown as Record<
            string,
            (...a: unknown[]) => unknown
          >;
          return new Proxy(builder, {
            get(b, method) {
              if (method === "update") db.tables.lessons[0].updated_at = "2026-10-06T10:00:05.000Z";
              return Reflect.get(b, method);
            },
          });
        };
      },
    });
    const error = await rejection(
      saveReviewedGraph(racing as never, OWNER, id, {
        graph: makeGraph(),
        expectedUpdatedAt: "2026-10-06T10:00:00.000Z",
      }),
    );
    expect(error).toMatchObject({ status: 409, code: "conflict" });
  });

  it("reports a database failure generically", async () => {
    const { id } = seed();
    db.failures.add("lessons.update");
    const error = await rejection(save(id, makeGraph()));
    expect(error).toMatchObject({ status: 500, code: "save_failed" });
    expect(error.message).not.toContain("injected");
  });

  it("reports a corrupt stored draft instead of overwriting it", async () => {
    const { id } = seed(makeGraph(), { graph: { nonsense: true } });
    expect(await rejection(save(id, makeGraph()))).toMatchObject({
      status: 500,
      code: "corrupt_graph",
    });
  });
});

describe("SaveGraphInput", () => {
  it("requires the version being edited", () => {
    expect(SaveGraphInput.safeParse({ graph: {} }).success).toBe(false);
    expect(SaveGraphInput.safeParse({ graph: {}, expectedUpdatedAt: "" }).success).toBe(false);
    expect(
      SaveGraphInput.safeParse({ graph: {}, expectedUpdatedAt: "2026-10-06T10:00:00.000Z" })
        .success,
    ).toBe(true);
  });
});
