import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/http";
import { getPublishedLesson, publishLesson } from "@/lib/lessons/publish-service";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { FakeSupabase } from "../fixtures/fake-supabase";
import { makeGraph } from "../fixtures/graph";

const OWNER = "11111111-1111-4111-8111-111111111111";
const LEARNER = "22222222-2222-4222-8222-222222222222";

let db: FakeSupabase;

const seed = (extra: Record<string, unknown> = {}, graph: unknown = makeGraph()) =>
  db.seedLesson({
    owner_id: OWNER,
    status: "needs_review",
    title: "The Water Cycle",
    graph,
    graph_version: 0,
    ...extra,
  }).id as string;

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error as ServiceError;
  }
  throw new Error("expected a rejection");
};

beforeEach(() => {
  db = new FakeSupabase();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("publishLesson", () => {
  it("publishes a valid draft and returns the new version", async () => {
    const id = seed();
    const result = await publishLesson(db.asUser(OWNER), OWNER, id);
    expect(result.version).toBe(1);
    expect(db.tables.lessons[0]).toMatchObject({ status: "published", graph_version: 1 });
  });

  it("returns the review warnings without blocking the publish", async () => {
    const graph = makeGraph();
    graph.quizItems = graph.quizItems.filter((q) => q.conceptId !== "c_condensation");
    const id = seed({}, graph);
    const result = await publishLesson(db.asUser(OWNER), OWNER, id);
    expect(result.warnings.some((w) => w.message.includes('"Condensation" has 0 quiz'))).toBe(true);
    expect(db.tables.lessons[0].status).toBe("published");
  });

  it("refuses a draft that does not validate, and publishes nothing", async () => {
    const broken: KnowledgeGraph = makeGraph();
    broken.quizItems[0].conceptId = "c_ghost";
    const id = seed({}, broken);
    const error = await rejection(publishLesson(db.asUser(OWNER), OWNER, id));
    expect(error).toMatchObject({ status: 422, code: "invalid_graph" });
    expect(db.tables.lessons[0].status).toBe("needs_review");
  });

  it("refuses a stored graph that is not a graph at all", async () => {
    const id = seed({}, { nonsense: true });
    expect((await rejection(publishLesson(db.asUser(OWNER), OWNER, id))).status).toBe(422);
  });

  it("treats someone else's lesson as not found", async () => {
    const id = seed();
    expect((await rejection(publishLesson(db.asUser(LEARNER), LEARNER, id))).status).toBe(404);
    expect(db.tables.lessons[0].status).toBe("needs_review");
  });

  it("treats a lesson that does not exist as not found", async () => {
    expect(
      (
        await rejection(
          publishLesson(db.asUser(OWNER), OWNER, "33333333-3333-4333-8333-333333333333"),
        )
      ).status,
    ).toBe(404);
  });

  it("refuses to publish twice", async () => {
    const id = seed({ status: "published", graph_version: 1 });
    expect(await rejection(publishLesson(db.asUser(OWNER), OWNER, id))).toMatchObject({
      status: 409,
      code: "already_published",
    });
  });

  it.each(["uploading", "processing", "failed"])("refuses a lesson that is %s", async (status) => {
    const id = seed({ status });
    expect(await rejection(publishLesson(db.asUser(OWNER), OWNER, id))).toMatchObject({
      status: 409,
      code: "not_ready",
    });
  });

  it("maps a database refusal to a conflict, not a server error", async () => {
    const id = seed();
    db.rpcHandlers.publish_lesson = () => ({
      data: null,
      error: { message: "lesson is not ready to publish", code: "P0001" },
    });
    expect(await rejection(publishLesson(db.asUser(OWNER), OWNER, id))).toMatchObject({
      status: 409,
    });
  });

  it("reports an unexpected database failure generically", async () => {
    const id = seed();
    db.failures.add("rpc.publish_lesson");
    const error = await rejection(publishLesson(db.asUser(OWNER), OWNER, id));
    expect(error).toMatchObject({ status: 500, code: "publish_failed" });
    expect(error.message).not.toContain("injected");
  });

  it("reports a missing version from the database as a failure", async () => {
    const id = seed();
    db.rpcHandlers.publish_lesson = () => ({ data: null, error: null });
    expect((await rejection(publishLesson(db.asUser(OWNER), OWNER, id))).status).toBe(500);
  });
});

describe("getPublishedLesson", () => {
  it("returns the published graph for a learner", async () => {
    const id = seed({ status: "published", graph_version: 2 });
    const lesson = await getPublishedLesson(db.asUser(LEARNER), id);
    expect(lesson).toMatchObject({ lessonId: id, title: "The Water Cycle", graphVersion: 2 });
    expect(lesson.graph.concepts).toHaveLength(3);
  });

  it("does not return a draft, even to its owner", async () => {
    const id = seed();
    expect((await rejection(getPublishedLesson(db.asUser(OWNER), id))).status).toBe(404);
  });

  it("hides another teacher's draft from a learner", async () => {
    const id = seed();
    expect((await rejection(getPublishedLesson(db.asUser(LEARNER), id))).status).toBe(404);
  });

  it("returns 404 for a lesson that does not exist", async () => {
    expect(
      (
        await rejection(
          getPublishedLesson(db.asUser(LEARNER), "33333333-3333-4333-8333-333333333333"),
        )
      ).status,
    ).toBe(404);
  });

  it("reports a damaged published graph instead of returning it", async () => {
    const id = seed({ status: "published" }, { nonsense: true });
    expect(await rejection(getPublishedLesson(db.asUser(LEARNER), id))).toMatchObject({
      status: 500,
      code: "corrupt_graph",
    });
  });
});
