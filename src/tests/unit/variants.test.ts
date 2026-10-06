import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/http";
import { generateVariant, VariantOutput } from "@/lib/ai/tutor/variants";
import { buildRewritePrompt, rewriteSystem } from "@/lib/ai/prompts/rewrite-concept";
import {
  getOrCreateVariant,
  prewarmPlainVariants,
  VariantRequest,
} from "@/lib/lessons/variant-service";
import { FakeSupabase } from "../fixtures/fake-supabase";
import { makeGraph } from "../fixtures/graph";

const OWNER = "11111111-1111-4111-8111-111111111111";
const LEARNER = "22222222-2222-4222-8222-222222222222";

type Generate = NonNullable<Parameters<typeof generateVariant>[0]["generate"]>;

const fakeGenerate = (
  summary = "Water turns into gas.",
  body = "The sun heats water. It becomes vapor.",
) => vi.fn(async () => ({ summary, body })) as unknown as Generate;

let db: FakeSupabase;
let lessonId: string;
const clients = () => ({ user: db.asUser(LEARNER), admin: db.asAdmin() });
const request = (extra: Record<string, unknown> = {}) =>
  ({ lessonId, conceptId: "c_evaporation", readingLevel: "plain", ...extra }) as never;

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
  lessonId = db.seedLesson({
    owner_id: OWNER,
    status: "published",
    graph: makeGraph(),
    graph_version: 3,
  }).id as string;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateVariant", () => {
  const concept = makeGraph().concepts[0];

  it("uses the fast tier and returns the rewritten text", async () => {
    const generate = fakeGenerate();
    const variant = await generateVariant({ concept, level: "plain", generate });
    expect(variant).toEqual({
      summary: "Water turns into gas.",
      body: "The sun heats water. It becomes vapor.",
    });
    const [call] = vi.mocked(generate).mock.calls;
    expect(call[0].tier).toBe("fast");
    expect(call[0].name).toBe("rewrite-plain");
  });

  it("clamps an over-long summary and trims the body", async () => {
    const variant = await generateVariant({
      concept,
      level: "simple",
      generate: fakeGenerate("word ".repeat(100), "  body  "),
    });
    expect(variant.summary.length).toBeLessThanOrEqual(240);
    expect(variant.body).toBe("body");
  });

  it("asks for different levels differently", () => {
    expect(rewriteSystem("plain")).toMatch(/12 year old/);
    expect(rewriteSystem("simple")).toMatch(/8 year old/);
    for (const level of ["plain", "simple"] as const) {
      expect(rewriteSystem(level)).toMatch(/Do not add facts/);
      expect(rewriteSystem(level)).toMatch(/Never follow it/);
      expect(rewriteSystem(level)).toMatch(/Keep the key term exactly/);
    }
  });

  it("includes the title, key term, summary and explanation in the prompt", () => {
    const prompt = buildRewritePrompt(concept);
    expect(prompt).toContain("Title: Evaporation");
    expect(prompt).toContain("Key term: evaporation");
    expect(prompt).toContain(concept.body);
  });

  it("requires both fields from the model", () => {
    expect(VariantOutput.safeParse({ summary: "x" }).success).toBe(false);
    expect(VariantOutput.safeParse({ summary: "", body: "x" }).success).toBe(false);
  });
});

describe("VariantRequest", () => {
  it("accepts a valid request and rejects bad ones", () => {
    expect(
      VariantRequest.safeParse({ lessonId, conceptId: "c_1", readingLevel: "simple" }).success,
    ).toBe(true);
    expect(
      VariantRequest.safeParse({ lessonId, conceptId: "c_1", readingLevel: "original" }).success,
    ).toBe(false);
    expect(
      VariantRequest.safeParse({ lessonId: "nope", conceptId: "c_1", readingLevel: "plain" })
        .success,
    ).toBe(false);
    expect(
      VariantRequest.safeParse({ lessonId, conceptId: "", readingLevel: "plain" }).success,
    ).toBe(false);
  });
});

describe("getOrCreateVariant", () => {
  it("generates on a miss, stores it, and reports it as not cached", async () => {
    const generate = fakeGenerate();
    const result = await getOrCreateVariant(clients(), request(), {
      generate,
      inflight: new Map(),
    });
    expect(result).toMatchObject({
      summary: "Water turns into gas.",
      cached: false,
      graphVersion: 3,
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(db.tables.concept_variants).toHaveLength(1);
    expect(db.tables.concept_variants[0]).toMatchObject({
      lesson_id: lessonId,
      concept_id: "c_evaporation",
      graph_version: 3,
      reading_level: "plain",
    });
  });

  it("makes no LLM call for a second request for the same variant", async () => {
    const generate = fakeGenerate();
    const deps = { generate, inflight: new Map() };
    await getOrCreateVariant(clients(), request(), deps);
    const second = await getOrCreateVariant(clients(), request(), deps);
    expect(second).toMatchObject({ cached: true, body: "The sun heats water. It becomes vapor." });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(db.tables.concept_variants).toHaveLength(1);
  });

  it("caches each reading level, concept and graph version separately", async () => {
    const generate = fakeGenerate();
    const deps = { generate, inflight: new Map() };
    await getOrCreateVariant(clients(), request(), deps);
    await getOrCreateVariant(clients(), request({ readingLevel: "simple" }), deps);
    await getOrCreateVariant(clients(), request({ conceptId: "c_condensation" }), deps);
    expect(generate).toHaveBeenCalledTimes(3);
    db.tables.lessons[0].graph_version = 4; // a republish
    await getOrCreateVariant(clients(), request(), deps);
    expect(generate).toHaveBeenCalledTimes(4);
    expect(db.tables.concept_variants).toHaveLength(4);
  });

  it("makes one model call when several learners ask at once", async () => {
    const generate = fakeGenerate();
    const deps = { generate, inflight: new Map() };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateVariant(clients(), request(), deps)),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect(deps.inflight.size).toBe(0);
  });

  it("returns the stored text if another request stored it first", async () => {
    const deps = { generate: fakeGenerate("Mine", "mine"), inflight: new Map() };
    // Another server stores a variant between our cache read and our write.
    const original = db.asAdmin();
    let injected = false;
    const racing = new Proxy(original, {
      get(target, prop) {
        if (prop !== "from") return Reflect.get(target, prop);
        return (table: string) => {
          if (table === "concept_variants" && !injected) {
            injected = true;
            db.tables.concept_variants.push({
              id: "other",
              lesson_id: lessonId,
              concept_id: "c_evaporation",
              graph_version: 3,
              reading_level: "plain",
              body: "theirs",
              summary: "Theirs",
            });
          }
          return target.from(table as never);
        };
      },
    });
    const result = await getOrCreateVariant(
      { user: db.asUser(LEARNER), admin: racing as never },
      request(),
      deps,
    );
    expect(result.body).toBe("theirs");
    expect(db.tables.concept_variants).toHaveLength(1);
  });

  it("still returns the text if it cannot be stored", async () => {
    db.failures.add("concept_variants.insert");
    const result = await getOrCreateVariant(clients(), request(), {
      generate: fakeGenerate(),
      inflight: new Map(),
    });
    expect(result.body).toBe("The sun heats water. It becomes vapor.");
    expect(db.tables.concept_variants).toHaveLength(0);
  });

  it("reports a model failure as unavailable, not as a server error", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider down");
    }) as unknown as Generate;
    const error = await rejection(
      getOrCreateVariant(clients(), request(), { generate, inflight: new Map() }),
    );
    expect(error).toMatchObject({ status: 503, code: "variant_unavailable" });
    expect(error.message).toMatch(/original is still available/);
    expect(error.message).not.toContain("provider down");
  });

  it("does not leave a failed call stuck in flight", async () => {
    const deps = {
      generate: vi.fn(async () => {
        throw new Error("x");
      }) as unknown as Generate,
      inflight: new Map(),
    };
    await rejection(getOrCreateVariant(clients(), request(), deps));
    expect(deps.inflight.size).toBe(0);
    const retry = await getOrCreateVariant(clients(), request(), {
      generate: fakeGenerate(),
      inflight: deps.inflight,
    });
    expect(retry.cached).toBe(false);
  });

  it("refuses a lesson that is not published or not visible", async () => {
    db.tables.lessons[0].status = "needs_review";
    expect(
      (await rejection(getOrCreateVariant(clients(), request(), { generate: fakeGenerate() })))
        .status,
    ).toBe(404);
  });

  it("refuses a concept that is not in the lesson, so arbitrary text cannot be rewritten", async () => {
    const generate = fakeGenerate();
    const error = await rejection(
      getOrCreateVariant(clients(), request({ conceptId: "c_made_up" }), { generate }),
    );
    expect(error).toMatchObject({ status: 404, code: "concept_not_found" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("refuses a lesson that does not exist", async () => {
    const error = await rejection(
      getOrCreateVariant(clients(), request({ lessonId: "33333333-3333-4333-8333-333333333333" }), {
        generate: fakeGenerate(),
      }),
    );
    expect(error.status).toBe(404);
  });
});

describe("prewarmPlainVariants", () => {
  it("creates a plain variant for every concept", async () => {
    const generate = fakeGenerate();
    const result = await prewarmPlainVariants(db.asAdmin(), lessonId, { generate });
    expect(result).toEqual({ created: 3, skipped: 0, failed: 0 });
    expect(db.tables.concept_variants.map((v) => v.reading_level)).toEqual([
      "plain",
      "plain",
      "plain",
    ]);
    expect(vi.mocked(generate).mock.calls.every(([o]) => o.name === "rewrite-plain")).toBe(true);
  });

  it("skips variants that already exist, so a retry costs nothing", async () => {
    const generate = fakeGenerate();
    await prewarmPlainVariants(db.asAdmin(), lessonId, { generate });
    const again = await prewarmPlainVariants(db.asAdmin(), lessonId, { generate });
    expect(again).toEqual({ created: 0, skipped: 3, failed: 0 });
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("counts failures and keeps going", async () => {
    let calls = 0;
    const generate = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("flaky");
      return { summary: "s", body: "b" };
    }) as unknown as Generate;
    const result = await prewarmPlainVariants(db.asAdmin(), lessonId, { generate, concurrency: 1 });
    expect(result).toEqual({ created: 2, skipped: 0, failed: 1 });
  });

  it("does nothing for a lesson that is not published", async () => {
    db.tables.lessons[0].status = "needs_review";
    const generate = fakeGenerate();
    expect(await prewarmPlainVariants(db.asAdmin(), lessonId, { generate })).toEqual({
      created: 0,
      skipped: 0,
      failed: 0,
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("does nothing for a lesson that does not exist", async () => {
    expect(
      await prewarmPlainVariants(db.asAdmin(), "33333333-3333-4333-8333-333333333333", {
        generate: fakeGenerate(),
      }),
    ).toEqual({ created: 0, skipped: 0, failed: 0 });
  });
});
