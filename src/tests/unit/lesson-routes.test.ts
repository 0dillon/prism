import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../fixtures/fake-supabase";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  db: null as unknown,
  userId: null as string | null,
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return {
    ...original,
    after: (callback: () => unknown) => {
      mocks.afterCallbacks.push(callback);
    },
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const db = mocks.db as FakeSupabase;
    const userId = mocks.userId;
    return {
      ...db.asUser(userId ?? "00000000-0000-4000-8000-000000000000"),
      auth: {
        getUser: async () =>
          userId
            ? { data: { user: { id: userId } }, error: null }
            : { data: { user: null }, error: { message: "no session" } },
      },
    };
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (mocks.db as FakeSupabase).asAdmin(),
}));

import { POST as createLessonRoute } from "@/app/api/lessons/route";
import { POST as ingestRoute } from "@/app/api/lessons/[id]/ingest/route";
import { GET as statusRoute } from "@/app/api/lessons/[id]/status/route";

let db: FakeSupabase;

const post = (url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

beforeEach(() => {
  db = new FakeSupabase();
  mocks.db = db;
  mocks.userId = OWNER;
  mocks.afterCallbacks = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/lessons", () => {
  it("returns 401 without a session", async () => {
    mocks.userId = null;
    const response = await createLessonRoute(
      post("/api/lessons", { fileName: "a.pdf", fileSize: 10 }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("unauthorized");
    expect(db.tables.lessons).toHaveLength(0);
  });

  it("creates a lesson and returns ids and an upload URL", async () => {
    const response = await createLessonRoute(
      post("/api/lessons", { fileName: "notes.md", fileSize: 2048 }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.lessonId).toBe(db.tables.lessons[0].id);
    expect(body.jobId).toBe(db.tables.ingestion_jobs[0].id);
    expect(body.upload).toMatchObject({
      token: "upload-token",
      path: `${OWNER}/${body.lessonId}/source.md`,
    });
  });

  it.each([
    ["not json", "{nope"],
    ["an empty body", ""],
    ["a missing file name", { fileSize: 10 }],
    ["a file over 50 MB", { fileName: "a.pdf", fileSize: 60 * 1024 * 1024 }],
  ])("returns 400 for %s", async (_name, body) => {
    const response = await createLessonRoute(post("/api/lessons", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message.length).toBeGreaterThan(0);
  });

  it("returns 400 with a plain message for a file type that is not accepted", async () => {
    const response = await createLessonRoute(
      post("/api/lessons", { fileName: "run.exe", fileSize: 10 }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("unsupported_type");
  });

  it("returns 500 with a generic message when the database fails", async () => {
    db.failures.add("lessons.insert");
    const response = await createLessonRoute(
      post("/api/lessons", { fileName: "a.pdf", fileSize: 10 }),
    );
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("injected");
  });
});

describe("POST /api/lessons/[id]/ingest", () => {
  const readyLesson = (owner = OWNER) => {
    const lesson = db.seedLesson({
      owner_id: owner,
      status: "uploading",
      source_type: "txt",
      source_path: `${owner}/l/source.txt`,
    });
    db.seedJob({ lesson_id: lesson.id });
    return lesson.id as string;
  };

  it("returns 401 without a session", async () => {
    mocks.userId = null;
    const response = await ingestRoute(post("/x"), ctx(readyLesson()));
    expect(response.status).toBe(401);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it("returns 202 immediately and schedules the run after the response", async () => {
    const id = readyLesson();
    const response = await ingestRoute(post("/x"), ctx(id));
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({ status: "processing", jobId: db.tables.ingestion_jobs[0].id });
    expect(db.tables.lessons[0].status).toBe("processing");
    expect(mocks.afterCallbacks).toHaveLength(1);
  });

  it("records a clear failure when the uploaded file is missing", async () => {
    const id = readyLesson();
    await ingestRoute(post("/x"), ctx(id));
    await mocks.afterCallbacks[0]();
    expect(db.tables.lessons[0].status).toBe("failed");
  });

  it("returns 404 for someone else's lesson and does not run anything", async () => {
    const id = readyLesson(OTHER);
    const response = await ingestRoute(post("/x"), ctx(id));
    expect(response.status).toBe(404);
    expect(mocks.afterCallbacks).toHaveLength(0);
  });

  it("returns 404 for an id that is not a UUID", async () => {
    const response = await ingestRoute(post("/x"), ctx("not-a-uuid"));
    expect(response.status).toBe(404);
  });

  it("returns 409 when the lesson is already being processed", async () => {
    const id = readyLesson();
    db.tables.lessons[0].status = "processing";
    const response = await ingestRoute(post("/x"), ctx(id));
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("already_running");
  });

  it("returns 409 for a published lesson", async () => {
    const id = readyLesson();
    db.tables.lessons[0].status = "published";
    expect((await ingestRoute(post("/x"), ctx(id))).status).toBe(409);
  });
});

describe("GET /api/lessons/[id]/status", () => {
  const get = () => new NextRequest("http://localhost/x");

  it("returns 401 without a session", async () => {
    mocks.userId = null;
    const lesson = db.seedLesson({ owner_id: OWNER });
    expect((await statusRoute(get(), ctx(lesson.id as string))).status).toBe(401);
  });

  it("returns the stage and progress, uncached", async () => {
    const lesson = db.seedLesson({ owner_id: OWNER, status: "processing" });
    db.seedJob({ lesson_id: lesson.id, stage: "merging", progress: 52 });
    const response = await statusRoute(get(), ctx(lesson.id as string));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      stage: "merging",
      stageLabel: "Organizing the lesson",
      progress: 52,
      ready: false,
      error: null,
    });
  });

  it("returns ready for a lesson awaiting review", async () => {
    const lesson = db.seedLesson({ owner_id: OWNER, status: "needs_review" });
    db.seedJob({ lesson_id: lesson.id, stage: "validating", progress: 95 });
    expect(await (await statusRoute(get(), ctx(lesson.id as string))).json()).toMatchObject({
      ready: true,
      progress: 100,
    });
  });

  it("returns 404 for someone else's lesson", async () => {
    const lesson = db.seedLesson({ owner_id: OTHER, status: "processing" });
    expect((await statusRoute(get(), ctx(lesson.id as string))).status).toBe(404);
  });

  it("returns 404 for a malformed id", async () => {
    expect((await statusRoute(get(), ctx("../../etc"))).status).toBe(404);
  });
});
