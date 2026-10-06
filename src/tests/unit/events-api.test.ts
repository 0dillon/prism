import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientEvent, EventBatchRequest, recordEvents } from "@/lib/events/service";
import type { UserClient } from "@/lib/api/http";

const LESSON = "11111111-1111-4111-8111-111111111111";
const OTHER_LESSON = "22222222-2222-4222-8222-222222222222";
const USER = "99999999-9999-4999-8999-999999999999";

const event = (id: string, over: Partial<ClientEvent> = {}): ClientEvent => ({
  id,
  lessonId: LESSON,
  graphVersion: 1,
  type: "concept_viewed",
  conceptId: "c1",
  layout: "cards",
  occurredAt: "2026-10-06T10:00:00.000Z",
  ...over,
});

interface Row {
  id: string;
  user_id: string;
  lesson_id: string;
  [key: string]: unknown;
}

/** A learning_events table that ignores repeated ids and refuses lessons the learner may not use. */
function fakeClient(options: { allowedLessons?: string[] } = {}) {
  const allowed = new Set(options.allowedLessons ?? [LESSON]);
  const rows = new Map<string, Row>();
  const calls: Row[][] = [];
  const client = {
    from: (table: string) => {
      if (table !== "learning_events") throw new Error(`unexpected table ${table}`);
      return {
        upsert: async (batch: Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean }) => {
          calls.push(batch);
          expect(opts).toEqual({ onConflict: "id", ignoreDuplicates: true });
          // Row-level security: all or nothing for one statement.
          if (batch.some((r) => !allowed.has(r.lesson_id))) {
            return {
              error: { code: "42501", message: "new row violates row-level security policy" },
            };
          }
          for (const row of batch) if (!rows.has(row.id)) rows.set(row.id, row);
          return { error: null };
        },
      };
    },
  } as unknown as UserClient;
  return { client, rows, calls };
}

describe("ClientEvent", () => {
  it("accepts an event without a user", () => {
    expect(ClientEvent.safeParse(event("e1")).success).toBe(true);
  });

  it("does not accept a user from the client", () => {
    const parsed = ClientEvent.parse({ ...event("e1"), userId: "someone-else" });
    expect("userId" in parsed).toBe(false);
  });

  it.each([
    ["a lesson id that is not a UUID", { lessonId: "demo-water-cycle" }],
    ["an unknown type", { type: "deleted_everything" }],
    ["a bad layout", { layout: "hologram" }],
    ["a time that is not a time", { occurredAt: "yesterday" }],
    ["a negative duration", { durationMs: -1 }],
    ["a duration of more than a day", { durationMs: 90_000_000 }],
    ["an empty id", { id: "" }],
    ["a very long id", { id: "x".repeat(41) }],
    ["a fractional version", { graphVersion: 1.5 }],
  ])("rejects %s", (_name, over) => {
    expect(ClientEvent.safeParse({ ...event("e1"), ...over }).success).toBe(false);
  });
});

describe("EventBatchRequest", () => {
  it("takes between one and 200 events", () => {
    expect(EventBatchRequest.safeParse({ events: [] }).success).toBe(false);
    expect(EventBatchRequest.safeParse({ events: [event("e1")] }).success).toBe(true);
    expect(
      EventBatchRequest.safeParse({ events: Array.from({ length: 200 }, (_, i) => event(`e${i}`)) })
        .success,
    ).toBe(true);
    expect(
      EventBatchRequest.safeParse({ events: Array.from({ length: 201 }, (_, i) => event(`e${i}`)) })
        .success,
    ).toBe(false);
  });
});

describe("recordEvents", () => {
  it("stores events for the signed-in learner, whatever the client said", async () => {
    const { client, rows } = fakeClient();
    const result = await recordEvents(client, USER, [
      event("e1"),
      event("e2", { type: "quiz_answered", correct: true, quizItemId: "q1" }),
    ]);
    expect(result).toEqual({ received: 2, rejected: 0 });
    expect([...rows.values()].every((r) => r.user_id === USER)).toBe(true);
    expect(rows.get("e2")).toMatchObject({
      type: "quiz_answered",
      correct: true,
      quiz_item_id: "q1",
      lesson_id: LESSON,
      graph_version: 1,
      layout: "cards",
      occurred_at: "2026-10-06T10:00:00.000Z",
    });
  });

  it("stores nothing new when the same batch is replayed", async () => {
    const { client, rows } = fakeClient();
    const batch = [event("e1"), event("e2")];
    await recordEvents(client, USER, batch);
    const before = JSON.stringify([...rows.values()]);
    const again = await recordEvents(client, USER, batch);
    expect(again).toEqual({ received: 2, rejected: 0 });
    expect(rows.size).toBe(2);
    expect(JSON.stringify([...rows.values()])).toBe(before);
  });

  it("stores only the new events when a batch partly overlaps an earlier one", async () => {
    const { client, rows } = fakeClient();
    await recordEvents(client, USER, [event("e1")]);
    await recordEvents(client, USER, [event("e1"), event("e2")]);
    expect([...rows.keys()]).toEqual(["e1", "e2"]);
  });

  it("keeps the good events and counts the one it may not store", async () => {
    const { client, rows } = fakeClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await recordEvents(client, USER, [
      event("e1"),
      event("e2", { lessonId: OTHER_LESSON }),
      event("e3"),
    ]);
    expect(result).toEqual({ received: 2, rejected: 1 });
    expect([...rows.keys()]).toEqual(["e1", "e3"]);
  });

  it("counts a single refused event", async () => {
    const { client, rows } = fakeClient({ allowedLessons: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await recordEvents(client, USER, [event("e1")])).toEqual({ received: 0, rejected: 1 });
    expect(rows.size).toBe(0);
  });

  it("does not log what the learner did", async () => {
    const { client } = fakeClient({ allowedLessons: [] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordEvents(client, USER, [event("e1", { conceptId: "secret-concept" })]);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret-concept");
  });

  it("leaves optional fields null", async () => {
    const { client, rows } = fakeClient();
    await recordEvents(client, USER, [event("e1", { conceptId: undefined })]);
    expect(rows.get("e1")).toMatchObject({
      concept_id: null,
      quiz_item_id: null,
      correct: null,
      duration_ms: null,
    });
  });
});

const mocks = vi.hoisted(() => ({
  userId: "99999999-9999-4999-8999-999999999999" as string | null,
  client: null as unknown,
}));
vi.mock("@/lib/api/http", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/http")>();
  return {
    ...original,
    requireUser: async () =>
      mocks.userId
        ? { ok: true, user: { id: mocks.userId }, supabase: mocks.client }
        : { ok: false, response: original.jsonError(401, "unauthorized", "Sign in to continue.") },
  };
});

describe("POST /api/events", () => {
  const call = async (body: unknown) => {
    const { POST } = await import("@/app/api/events/route");
    return POST(
      new NextRequest("http://localhost/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  };

  let fake: ReturnType<typeof fakeClient>;
  beforeEach(() => {
    fake = fakeClient();
    mocks.client = fake.client;
    mocks.userId = USER;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stores the batch and says how many it has", async () => {
    const response = await call({ events: [event("a1"), event("a2")] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 2, rejected: 0 });
    expect(fake.rows.size).toBe(2);
  });

  it("stores nothing new when the batch is replayed", async () => {
    const batch = { events: [event("r1"), event("r2")] };
    await call(batch);
    await call(batch);
    expect(fake.rows.size).toBe(2);
  });

  it("ignores a userId in the body and uses the signed-in learner", async () => {
    await call({ events: [{ ...event("u1"), userId: "88888888-8888-4888-8888-888888888888" }] });
    expect(fake.rows.get("u1")?.user_id).toBe(USER);
  });

  it("needs a signed-in learner", async () => {
    mocks.userId = null;
    expect((await call({ events: [event("x1")] })).status).toBe(401);
    expect(fake.rows.size).toBe(0);
  });

  it("rejects a bad batch with a 400, which the client treats as final", async () => {
    expect((await call({ events: [] })).status).toBe(400);
    expect((await call({ events: [{ ...event("b1"), type: "nope" }] })).status).toBe(400);
    expect((await call("not json")).status).toBe(400);
    expect((await call({})).status).toBe(400);
  });

  it("reports events it could not store, without failing the batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await call({ events: [event("g1"), event("g2", { lessonId: OTHER_LESSON })] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: 1, rejected: 1 });
  });

  it("limits how often one learner can send", async () => {
    mocks.userId = "limited-learner";
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) last = await call({ events: [event(`l${i}`)] });
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
