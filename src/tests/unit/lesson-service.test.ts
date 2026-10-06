import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceError } from "@/lib/api/http";
import type { IngestionResult } from "@/lib/ai/ingestion/pipeline";
import {
  createLesson,
  CreateLessonInput,
  getLessonStatus,
  startIngestion,
  STALE_RUN_MS,
} from "@/lib/lessons/service";
import { MAX_UPLOAD_BYTES } from "@/lib/supabase/storage";
import { FakeSupabase } from "../fixtures/fake-supabase";
import { MemoryStore } from "../fixtures/memory-store";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let db: FakeSupabase;
const clientsFor = (userId: string) => ({ user: db.asUser(userId), admin: db.asAdmin() });

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

describe("CreateLessonInput", () => {
  it("accepts a normal upload", () => {
    expect(CreateLessonInput.safeParse({ fileName: "notes.pdf", fileSize: 1024 }).success).toBe(
      true,
    );
  });

  it.each([
    ["no file name", { fileName: "", fileSize: 10 }],
    ["zero bytes", { fileName: "a.pdf", fileSize: 0 }],
    ["more than 50 MB", { fileName: "a.pdf", fileSize: MAX_UPLOAD_BYTES + 1 }],
    ["a fractional size", { fileName: "a.pdf", fileSize: 1.5 }],
    ["a very long title", { fileName: "a.pdf", fileSize: 10, title: "x".repeat(121) }],
    ["a missing size", { fileName: "a.pdf" }],
  ])("rejects %s", (_name, input) => {
    expect(CreateLessonInput.safeParse(input).success).toBe(false);
  });

  it("accepts a file of exactly 50 MB", () => {
    expect(
      CreateLessonInput.safeParse({ fileName: "a.pdf", fileSize: MAX_UPLOAD_BYTES }).success,
    ).toBe(true);
  });
});

describe("createLesson", () => {
  it("creates the lesson, the job and a signed upload URL for the owner's folder", async () => {
    const created = await createLesson(clientsFor(OWNER), OWNER, {
      fileName: "Water Cycle Notes.PDF",
      fileSize: 5000,
    });

    const lesson = db.tables.lessons[0];
    expect(lesson).toMatchObject({
      id: created.lessonId,
      owner_id: OWNER,
      status: "uploading",
      source_type: "pdf",
      title: "Water Cycle Notes",
      source_path: `${OWNER}/${created.lessonId}/source.pdf`,
    });
    expect(db.tables.ingestion_jobs[0]).toMatchObject({
      id: created.jobId,
      lesson_id: created.lessonId,
      stage: "uploading",
      progress: 0,
    });
    expect(created.upload.path).toBe(`${OWNER}/${created.lessonId}/source.pdf`);
    expect(created.upload.token).toBe("upload-token");
    expect(db.uploadUrls).toEqual([{ bucket: "sources", path: created.upload.path }]);
  });

  it("uses the given title over the file name", async () => {
    await createLesson(clientsFor(OWNER), OWNER, {
      fileName: "a.txt",
      fileSize: 10,
      title: "My Title",
    });
    expect(db.tables.lessons[0].title).toBe("My Title");
  });

  it("never puts the original file name in the storage path", async () => {
    const created = await createLesson(clientsFor(OWNER), OWNER, {
      fileName: "../../etc/passwd.txt",
      fileSize: 10,
    });
    expect(created.upload.path).toBe(`${OWNER}/${created.lessonId}/source.txt`);
  });

  it("rejects a file type that is not accepted", async () => {
    const error = await rejection(
      createLesson(clientsFor(OWNER), OWNER, { fileName: "virus.exe", fileSize: 10 }),
    );
    expect(error).toMatchObject({ status: 400, code: "unsupported_type" });
    expect(db.tables.lessons).toHaveLength(0);
  });

  it.each([
    ["notes.docx", /Word documents are not supported yet/],
    ["talk.mp3", /Audio files are not supported yet/],
    ["talk.m4a", /Audio files are not supported yet/],
  ])("rejects %s with a plain explanation, before creating anything", async (fileName, message) => {
    const error = await rejection(
      createLesson(clientsFor(OWNER), OWNER, { fileName, fileSize: 10 }),
    );
    expect(error).toMatchObject({ status: 400, code: "unsupported_yet" });
    expect(error.message).toMatch(message);
    expect(db.tables.lessons).toHaveLength(0);
  });

  it("cleans up the lesson if the upload URL cannot be made", async () => {
    db.failures.add("storage.sign");
    const error = await rejection(
      createLesson(clientsFor(OWNER), OWNER, { fileName: "a.pdf", fileSize: 10 }),
    );
    expect(error).toMatchObject({ status: 500, code: "create_failed" });
    expect(db.tables.lessons).toHaveLength(0);
  });

  it("cleans up if the job cannot be created", async () => {
    db.failures.add("ingestion_jobs.insert");
    const error = await rejection(
      createLesson(clientsFor(OWNER), OWNER, { fileName: "a.pdf", fileSize: 10 }),
    );
    expect(error.status).toBe(500);
    expect(db.tables.lessons).toHaveLength(0);
  });

  it("reports a failure to create the lesson without leaking internals", async () => {
    db.failures.add("lessons.insert");
    const error = await rejection(
      createLesson(clientsFor(OWNER), OWNER, { fileName: "a.pdf", fileSize: 10 }),
    );
    expect(error.message).not.toContain("injected");
  });

  it("will not create a lesson owned by someone else", async () => {
    // The user client enforces owner_id = auth.uid(), as row-level security does.
    const error = await rejection(
      createLesson(clientsFor(OWNER), OTHER, { fileName: "a.pdf", fileSize: 10 }),
    );
    expect(error.status).toBe(500);
    expect(db.tables.lessons).toHaveLength(0);
  });
});

describe("startIngestion", () => {
  const readyToRun = (extra: Record<string, unknown> = {}) => {
    const lesson = db.seedLesson({
      owner_id: OWNER,
      status: "uploading",
      source_type: "pdf",
      source_path: `${OWNER}/lesson/source.pdf`,
      ...extra,
    });
    const job = db.seedJob({ lesson_id: lesson.id });
    return { lesson, job };
  };

  it("marks the lesson as processing and returns the job and a runner", async () => {
    const { lesson, job } = readyToRun();
    const store = new MemoryStore();
    const started = await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, { store });
    expect(started.jobId).toBe(job.id);
    expect(store.lessonStatus).toBe("processing");
  });

  it("runs the pipeline with the stored path and the right extension", async () => {
    const { lesson, job } = readyToRun();
    const run = vi.fn(async (): Promise<IngestionResult> => ({
      status: "failed",
      stage: "reading",
      error: "x",
    }));
    const started = await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, {
      store: new MemoryStore(),
      run: run as never,
    });
    await started.run();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        lessonId: lesson.id,
        sourcePath: `${OWNER}/lesson/source.pdf`,
        fileName: "source.pdf",
      }),
    );
  });

  it("does nothing until the runner is called", async () => {
    const { lesson } = readyToRun();
    const run = vi.fn();
    await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, {
      store: new MemoryStore(),
      run: run as never,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("treats someone else's lesson as not found", async () => {
    const { lesson } = readyToRun();
    const error = await rejection(
      startIngestion(clientsFor(OTHER), OTHER, lesson.id as string, { store: new MemoryStore() }),
    );
    expect(error).toMatchObject({ status: 404, code: "not_found" });
  });

  it("treats a published lesson owned by someone else as not found, not forbidden", async () => {
    const lesson = db.seedLesson({
      owner_id: OWNER,
      status: "published",
      source_path: "x/y/source.pdf",
      source_type: "pdf",
    });
    const error = await rejection(
      startIngestion(clientsFor(OTHER), OTHER, lesson.id as string, { store: new MemoryStore() }),
    );
    expect(error.status).toBe(404);
  });

  it("treats a lesson that does not exist as not found", async () => {
    const error = await rejection(
      startIngestion(clientsFor(OWNER), OWNER, "33333333-3333-4333-8333-333333333333", {
        store: new MemoryStore(),
      }),
    );
    expect(error.status).toBe(404);
  });

  it("refuses to reprocess a published lesson", async () => {
    const { lesson } = readyToRun({ status: "published" });
    const error = await rejection(
      startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, { store: new MemoryStore() }),
    );
    expect(error).toMatchObject({ status: 409, code: "already_published" });
  });

  it("asks for an upload first when there is no source file", async () => {
    const { lesson } = readyToRun({ source_path: null, source_type: null });
    const error = await rejection(
      startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, { store: new MemoryStore() }),
    );
    expect(error).toMatchObject({ status: 409, code: "no_source" });
  });

  it("refuses to start a second run while one is active", async () => {
    const { lesson } = readyToRun({ status: "processing" });
    const error = await rejection(
      startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, { store: new MemoryStore() }),
    );
    expect(error).toMatchObject({ status: 409, code: "already_running" });
  });

  it("allows a retry once a processing run has gone quiet", async () => {
    const { lesson, job } = readyToRun({ status: "processing" });
    const store = new MemoryStore();
    const later = Date.parse(job.updated_at as string) + STALE_RUN_MS + 1000;
    const started = await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, {
      store,
      now: () => later,
    });
    expect(started.jobId).toBe(job.id);
  });

  it("resumes a failed lesson with the same job, so finished steps are reused", async () => {
    const { lesson, job } = readyToRun({ status: "failed" });
    const started = await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, {
      store: new MemoryStore(),
    });
    expect(started.jobId).toBe(job.id);
    expect(db.tables.ingestion_jobs).toHaveLength(1);
  });

  it("creates a job if the lesson somehow has none", async () => {
    const lesson = db.seedLesson({
      owner_id: OWNER,
      source_type: "txt",
      source_path: `${OWNER}/l/source.txt`,
    });
    const started = await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, {
      store: new MemoryStore(),
    });
    expect(db.tables.ingestion_jobs).toHaveLength(1);
    expect(db.tables.ingestion_jobs[0].id).toBe(started.jobId);
  });

  it("uses the newest job when there are several", async () => {
    const lesson = db.seedLesson({
      owner_id: OWNER,
      source_type: "txt",
      source_path: `${OWNER}/l/source.txt`,
    });
    db.seedJob({ lesson_id: lesson.id, created_at: "2026-01-01T00:00:00.000Z" });
    const newest = db.seedJob({ lesson_id: lesson.id, created_at: "2026-06-01T00:00:00.000Z" });
    const started = await startIngestion(clientsFor(OWNER), OWNER, lesson.id as string, {
      store: new MemoryStore(),
    });
    expect(started.jobId).toBe(newest.id);
  });
});

describe("getLessonStatus", () => {
  const seed = (lessonExtra: Record<string, unknown>, jobExtra: Record<string, unknown> = {}) => {
    const lesson = db.seedLesson({ owner_id: OWNER, ...lessonExtra });
    db.seedJob({ lesson_id: lesson.id, ...jobExtra });
    return lesson.id as string;
  };

  it("reports the stage, a label and progress while processing", async () => {
    const id = seed({ status: "processing" }, { stage: "extracting", progress: 30 });
    expect(await getLessonStatus(db.asUser(OWNER), OWNER, id)).toEqual({
      lessonId: id,
      lessonStatus: "processing",
      stage: "extracting",
      stageLabel: "Finding the key ideas",
      progress: 30,
      error: null,
      ready: false,
    });
  });

  it("reports ready at 100 when the lesson needs review", async () => {
    const id = seed({ status: "needs_review" }, { stage: "validating", progress: 95 });
    expect(await getLessonStatus(db.asUser(OWNER), OWNER, id)).toMatchObject({
      stage: "ready",
      stageLabel: "Ready for review",
      progress: 100,
      ready: true,
    });
  });

  it("reports the failure message", async () => {
    const id = seed(
      { status: "failed" },
      { stage: "merging", progress: 52, error: "The PDF has no text layer." },
    );
    expect(await getLessonStatus(db.asUser(OWNER), OWNER, id)).toMatchObject({
      error: "The PDF has no text layer.",
      ready: false,
      stage: "merging",
    });
  });

  it("falls back to a generic failure message", async () => {
    const id = seed({ status: "failed" }, { error: null });
    const status = await getLessonStatus(db.asUser(OWNER), OWNER, id);
    expect(status.error).toMatch(/Processing failed/);
  });

  it("does not show an old error on a lesson that is processing again", async () => {
    const id = seed({ status: "processing" }, { error: "stale error" });
    expect((await getLessonStatus(db.asUser(OWNER), OWNER, id)).error).toBeNull();
  });

  it("copes with a stage name it does not know", async () => {
    const id = seed({ status: "processing" }, { stage: "mystery" });
    expect((await getLessonStatus(db.asUser(OWNER), OWNER, id)).stage).toBe("uploading");
  });

  it("hides someone else's lesson", async () => {
    const id = seed({ status: "processing" });
    const error = await rejection(getLessonStatus(db.asUser(OTHER), OTHER, id));
    expect(error).toMatchObject({ status: 404 });
  });
});
