import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamTutorTurn, TutorRequestError } from "@/lib/ai/tutor/client";
import { requireConcept, streamTextResponse, loadTutorLesson } from "@/lib/ai/tutor/service";
import { SAMPLE_LESSON, SAMPLE_LESSON_ID } from "@/lib/demo/sample-lesson";
import { ServiceError } from "@/lib/api/http";
import { makeGraph } from "../fixtures/graph";

const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  pieces: ["Water ", "rises."] as string[],
  streamError: null as Error | null,
  published: null as unknown,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: mocks.userId ? { id: mocks.userId } : null } }),
    },
  }),
}));
vi.mock("@/lib/lessons/publish-service", () => ({
  getPublishedLesson: async () => {
    if (!mocks.published) throw new ServiceError(404, "not_found", "Lesson not found.");
    return mocks.published;
  },
}));
vi.mock("@/lib/ai/llm", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/ai/llm")>();
  return {
    ...original,
    streamText: vi.fn(async function* () {
      if (mocks.streamError) throw mocks.streamError;
      for (const piece of mocks.pieces) yield piece;
    }),
  };
});

const UUID = "11111111-1111-4111-8111-111111111111";

async function call(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/tutor/turn/route");
  return POST(
    new NextRequest("http://localhost/api/tutor/turn", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const demoBody = (intent: unknown = { type: "question", text: "Why does water rise?" }) => ({
  lessonId: SAMPLE_LESSON_ID,
  conceptId: "c_evaporation",
  intent,
});

beforeEach(() => {
  mocks.userId = null;
  mocks.pieces = ["Water ", "rises."];
  mocks.streamError = null;
  mocks.published = { lessonId: UUID, graphVersion: 1, graph: makeGraph(), title: "T" };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/tutor/turn", () => {
  it("streams the reply as plain text for the public demo lesson, without sign-in", async () => {
    const response = await call(demoBody());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Water rises.");
  });

  it("answers a question outside the lesson with a reply that says so", async () => {
    mocks.pieces = ["[NOT_COVERED]"];
    const response = await call(
      demoBody({ type: "question", text: "Who won the 1998 World Cup?" }),
    );
    const text = await response.text();
    expect(text).toMatch(/doesn't cover that/);
    expect(text).toContain("Evaporation");
  });

  it("needs sign-in for a lesson that is not the demo", async () => {
    const response = await call({ ...demoBody(), lessonId: UUID });
    expect(response.status).toBe(401);
  });

  it("reads a real lesson through the signed-in learner's own access", async () => {
    mocks.userId = "u1";
    const response = await call({
      lessonId: UUID,
      conceptId: "c_condensation",
      intent: { type: "elaborate" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Water rises.");
  });

  it("says not found for a lesson the learner may not see, or an id that is not one", async () => {
    mocks.userId = "u1";
    mocks.published = null;
    expect(
      (await call({ lessonId: UUID, conceptId: "c", intent: { type: "elaborate" } })).status,
    ).toBe(404);
    expect(
      (await call({ lessonId: "not-a-uuid", conceptId: "c", intent: { type: "elaborate" } }))
        .status,
    ).toBe(404);
  });

  it("says not found for an idea that is not in the lesson", async () => {
    const response = await call({ ...demoBody(), conceptId: "c_nope" });
    expect(response.status).toBe(404);
  });

  it("rejects a bad body with a 400", async () => {
    expect((await call({ lessonId: "x" })).status).toBe(400);
    expect((await call("nope")).status).toBe(400);
    expect((await call(demoBody({ type: "question", text: "" }))).status).toBe(400);
    expect((await call(demoBody({ type: "next" }))).status).toBe(400);
  });

  it("reports a model failure before streaming starts, not as a broken stream", async () => {
    mocks.streamError = new Error("no api key");
    const response = await call(demoBody());
    expect(response.status).toBe(500);
    expect((await response.json()).error.message).not.toMatch(/api key/);
  });

  it("limits how often one address can use the demo", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 21; i++) {
      last = await call(demoBody(), { "x-forwarded-for": "203.0.113.9" });
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    const other = await call(demoBody(), { "x-forwarded-for": "203.0.113.10" });
    expect(other.status).toBe(200);
  });
});

describe("tutor service", () => {
  it("serves the demo lesson without a user", async () => {
    expect(await loadTutorLesson(SAMPLE_LESSON_ID, null)).toEqual({
      graph: SAMPLE_LESSON,
      isDemo: true,
    });
  });

  it("checks that the idea is in the lesson", () => {
    expect(() => requireConcept(SAMPLE_LESSON, "c_evaporation")).not.toThrow();
    expect(() => requireConcept(SAMPLE_LESSON, "zzz")).toThrow(ServiceError);
  });

  it("stops the model when the listener goes away", async () => {
    let closed = false;
    async function* pieces() {
      try {
        yield "a";
        yield "b";
        yield "c";
      } finally {
        closed = true;
      }
    }
    const response = await streamTextResponse(pieces());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(closed).toBe(true);
  });

  it("sends an empty body for a reply with no pieces", async () => {
    async function* none(): AsyncGenerator<string> {}
    expect(await (await streamTextResponse(none())).text()).toBe("");
  });
});

describe("streamTutorTurn (client)", () => {
  const request = { lessonId: "l", conceptId: "c", intent: { type: "elaborate" as const } };
  const streamed = (pieces: string[], status = 200) =>
    vi.fn(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          for (const p of pieces) controller.enqueue(encoder.encode(p));
          controller.close();
        },
      });
      return new Response(body, { status });
    }) as unknown as typeof fetch;

  it("hands over each piece as it arrives and returns the whole reply", async () => {
    const seen: string[] = [];
    const text = await streamTutorTurn(request, {
      fetchFn: streamed(["Hello ", "there."]),
      onText: (p) => seen.push(p),
    });
    expect(seen).toEqual(["Hello ", "there."]);
    expect(text).toBe("Hello there.");
  });

  it("posts the request as JSON", async () => {
    const fetchFn = streamed(["x"]);
    await streamTutorTurn(request, { fetchFn });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0];
    expect(url).toBe("/api/tutor/turn");
    expect(JSON.parse(init!.body as string)).toEqual(request);
  });

  it("decodes a multi-byte character split between pieces", async () => {
    const bytes = new TextEncoder().encode("café");
    const fetchFn = vi.fn(async () => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4)); // cuts the é in half
          controller.enqueue(bytes.slice(4));
          controller.close();
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    expect(await streamTutorTurn(request, { fetchFn })).toBe("café");
  });

  it("uses the server's message for an error, with its status", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Please wait." } }), { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(streamTutorTurn(request, { fetchFn })).rejects.toMatchObject({
      message: "Please wait.",
      status: 429,
    });
  });

  it("falls back to a plain message when the error has no body", async () => {
    const fetchFn = vi.fn(
      async () => new Response("x", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(streamTutorTurn(request, { fetchFn })).rejects.toThrow(/could not answer/);
  });

  it("explains a lost connection", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("down");
    }) as unknown as typeof fetch;
    await expect(streamTutorTurn(request, { fetchFn })).rejects.toBeInstanceOf(TutorRequestError);
  });

  it("passes an abort through rather than hiding it as a connection problem", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchFn = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    await expect(
      streamTutorTurn(request, { fetchFn, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps what arrived if the stream breaks part-way", async () => {
    const fetchFn = vi.fn(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("Partly "));
        },
        pull(controller) {
          controller.error(new Error("cut"));
        },
      });
      return new Response(body);
    }) as unknown as typeof fetch;
    expect(await streamTutorTurn(request, { fetchFn })).toBe("Partly ");
  });
});
