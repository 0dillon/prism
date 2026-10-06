import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "@/lib/rate-limit";
import { presetProfile } from "@/lib/profile/presets";
import { logUnmetNeeds, parseNeedsRequest, ParseNeedsInput } from "@/lib/profile/parse-service";
import { FakeSupabase } from "../fixtures/fake-supabase";

const mocks = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        mocks.userId ? { data: { user: { id: mocks.userId } } } : { data: { user: null } },
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (mocks.db as FakeSupabase).asAdmin(),
}));
vi.mock("@/lib/ai/llm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/llm")>();
  return {
    ...original,
    generateStructured: vi.fn(async () => ({
      patch: { layout: "cards" },
      explanation: "I switched to cards.",
      unsupported: ["a unicorn"],
    })),
  };
});

const USER = "11111111-1111-4111-8111-111111111111";

type Generate = NonNullable<Parameters<typeof parseNeedsRequest>[1]["generate"]>;
const answer = (
  patch: Record<string, unknown>,
  explanation = "Done.",
  unsupported: string[] = [],
) => vi.fn(async () => ({ patch, explanation, unsupported })) as unknown as Generate;

let db: FakeSupabase;

beforeEach(() => {
  db = new FakeSupabase();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const request = (text = "one idea at a time") =>
  ParseNeedsInput.parse({ text, profile: presetProfile("standard") });

describe("ParseNeedsInput", () => {
  it("accepts text with a valid profile and trims it", () => {
    expect(ParseNeedsInput.parse({ text: "  hi  ", profile: presetProfile("standard") }).text).toBe(
      "hi",
    );
  });

  it.each([
    ["empty text", { text: "   ", profile: presetProfile("standard") }],
    ["text over 1000 characters", { text: "x".repeat(1001), profile: presetProfile("standard") }],
    ["an invalid profile", { text: "hi", profile: { layout: "cards" } }],
    ["no profile", { text: "hi" }],
  ])("rejects %s", (_name, body) => {
    expect(ParseNeedsInput.safeParse(body).success).toBe(false);
  });
});

describe("parseNeedsRequest", () => {
  it("returns the new profile, plain language changes and the explanation", async () => {
    const result = await parseNeedsRequest(request(), {
      admin: db.asAdmin(),
      userId: USER,
      generate: answer(
        { layout: "cards", quiz: { cadence: 3 } },
        "I switched to cards with a quiz every 3 concepts.",
      ),
    });
    expect(result).toMatchObject({
      ok: true,
      explanation: "I switched to cards with a quiz every 3 concepts.",
      profile: { layout: "cards", quiz: { cadence: 3 } },
    });
    if (result.ok) expect(result.changes).toContain("Showing the lesson as cards");
  });

  it("logs unsupported requests to the unmet needs table with the user", async () => {
    await parseNeedsRequest(request("make the text sing"), {
      admin: db.asAdmin(),
      userId: USER,
      generate: answer({}, "I cannot do that yet.", ["make the text sing"]),
    });
    expect(db.tables.unmet_needs).toHaveLength(1);
    expect(db.tables.unmet_needs[0]).toMatchObject({
      user_id: USER,
      request_text: "make the text sing",
    });
  });

  it("logs for a signed-out visitor without a user id", async () => {
    await parseNeedsRequest(request(), {
      admin: db.asAdmin(),
      userId: null,
      generate: answer({}, "x", ["a hologram"]),
    });
    expect(db.tables.unmet_needs[0].user_id).toBeNull();
  });

  it("logs nothing when everything was supported", async () => {
    await parseNeedsRequest(request(), {
      admin: db.asAdmin(),
      userId: USER,
      generate: answer({ layout: "cards" }),
    });
    expect(db.tables.unmet_needs).toHaveLength(0);
  });

  it("keeps the profile and says so when the model's patch is invalid", async () => {
    const result = await parseNeedsRequest(request(), {
      admin: db.asAdmin(),
      userId: USER,
      generate: answer({ quiz: { cadence: 99 } }, "ok", ["something else"]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/your settings are unchanged/);
    expect(db.tables.unmet_needs).toHaveLength(1); // the unsupported note is still recorded
  });

  it("explains kindly when nothing could be changed", async () => {
    const result = await parseNeedsRequest(request(), {
      admin: db.asAdmin(),
      userId: USER,
      generate: answer({}, "", ["a unicorn"]),
    });
    expect(result.ok && result.explanation).toMatch(/nothing changed/);
  });

  it("does not fail the request if logging fails", async () => {
    db.failures.add("unmet_needs.insert");
    const result = await parseNeedsRequest(request(), {
      admin: db.asAdmin(),
      userId: USER,
      generate: answer({ layout: "cards" }, "ok", ["x"]),
    });
    expect(result.ok).toBe(true);
  });
});

describe("logUnmetNeeds", () => {
  it("caps how many and how long, and does nothing for an empty list", async () => {
    await logUnmetNeeds(db.asAdmin(), null, []);
    expect(db.tables.unmet_needs).toHaveLength(0);
    await logUnmetNeeds(
      db.asAdmin(),
      null,
      Array.from({ length: 30 }, () => "y".repeat(900)),
    );
    expect(db.tables.unmet_needs).toHaveLength(10);
    expect((db.tables.unmet_needs[0].request_text as string).length).toBe(500);
  });
});

describe("createRateLimiter", () => {
  it("allows up to the limit, then refuses with a retry time", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 3; i++) expect(limiter.consume("a").allowed).toBe(true);
    now = 20_000;
    expect(limiter.consume("a")).toEqual({ allowed: false, retryAfterSeconds: 40 });
  });

  it("allows again once the window has passed", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    now = 1001;
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("tracks callers separately", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
  });

  it("does not let refused requests extend the wait", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    limiter.consume("a");
    for (now = 100; now < 900; now += 100) limiter.consume("a");
    now = 1001;
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("bounds the number of tracked callers", () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 5 });
    for (let i = 0; i < 50; i++) limiter.consume(`key-${i}`);
    expect(limiter.size()).toBeLessThanOrEqual(5);
  });
});

describe("POST /api/profile/parse", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost/api/profile/parse", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    mocks.db = db;
    mocks.userId = null;
  });

  it("works for a signed-out visitor and returns the new profile", async () => {
    const { POST } = await import("@/app/api/profile/parse/route");
    const response = await POST(
      post(
        { text: "cards please", profile: presetProfile("standard") },
        { "x-forwarded-for": "9.9.9.1" },
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      profile: { layout: "cards" },
      explanation: "I switched to cards.",
    });
    expect(db.tables.unmet_needs[0]).toMatchObject({ user_id: null, request_text: "a unicorn" });
  });

  it("attributes unmet needs to a signed-in user", async () => {
    const { POST } = await import("@/app/api/profile/parse/route");
    mocks.userId = USER;
    await POST(post({ text: "x", profile: presetProfile("standard") }));
    expect(db.tables.unmet_needs[0].user_id).toBe(USER);
  });

  it("returns 400 for a bad body", async () => {
    const { POST } = await import("@/app/api/profile/parse/route");
    const response = await POST(
      post({ text: "", profile: presetProfile("standard") }, { "x-forwarded-for": "9.9.9.2" }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 429 with Retry-After once a caller has made too many requests", async () => {
    const { POST } = await import("@/app/api/profile/parse/route");
    const ip = { "x-forwarded-for": "9.9.9.3" };
    let last = 200;
    let retry: string | null = null;
    for (let i = 0; i < 12; i++) {
      const response = await POST(post({ text: "x", profile: presetProfile("standard") }, ip));
      last = response.status;
      retry = response.headers.get("retry-after");
    }
    expect(last).toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
  });

  it("limits each caller separately", async () => {
    const { POST } = await import("@/app/api/profile/parse/route");
    for (let i = 0; i < 12; i++)
      await POST(
        post({ text: "x", profile: presetProfile("standard") }, { "x-forwarded-for": "9.9.9.4" }),
      );
    const other = await POST(
      post({ text: "x", profile: presetProfile("standard") }, { "x-forwarded-for": "9.9.9.5" }),
    );
    expect(other.status).toBe(200);
  });
});
