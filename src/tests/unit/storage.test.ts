import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import {
  BUCKETS,
  createSignedDownloadUrl,
  createSignedUploadUrl,
  fileExtension,
  lessonMediaPath,
  MAX_SIGNED_URL_TTL_SECONDS,
  sourcePath,
  sourceTypeFromFileName,
} from "@/lib/supabase/storage";

type FakeBucket = {
  createSignedUploadUrl: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
};

function fakeClient(bucket: Partial<FakeBucket> = {}) {
  const methods: FakeBucket = {
    createSignedUploadUrl: vi.fn(async (path: string) => ({
      data: { path, token: "tok", signedUrl: `https://storage.test/upload/${path}?token=tok` },
      error: null,
    })),
    createSignedUrl: vi.fn(async (path: string, expiresIn: number) => ({
      data: { signedUrl: `https://storage.test/object/${path}?exp=${expiresIn}` },
      error: null,
    })),
    ...bucket,
  };
  const from = vi.fn(() => methods);
  return {
    client: { storage: { from } } as unknown as Pick<SupabaseClient, "storage">,
    from,
    methods,
  };
}

describe("signed upload", () => {
  it("requests an upload URL for the bucket and path", async () => {
    const { client, from, methods } = fakeClient();
    const upload = await createSignedUploadUrl(client, BUCKETS.sources, "u/l/source.pdf");
    expect(from).toHaveBeenCalledWith("sources");
    expect(methods.createSignedUploadUrl).toHaveBeenCalledWith("u/l/source.pdf");
    expect(upload).toEqual({
      path: "u/l/source.pdf",
      token: "tok",
      signedUrl: "https://storage.test/upload/u/l/source.pdf?token=tok",
    });
  });

  it("surfaces storage errors", async () => {
    const { client } = fakeClient({
      createSignedUploadUrl: vi.fn(async () => ({ data: null, error: { message: "denied" } })),
    });
    await expect(createSignedUploadUrl(client, BUCKETS.sources, "x")).rejects.toThrow(/denied/);
  });
});

describe("signed download", () => {
  it("defaults to one hour", async () => {
    const { client, methods } = fakeClient();
    const url = await createSignedDownloadUrl(client, BUCKETS.lessonMedia, "l/cover.png");
    expect(methods.createSignedUrl).toHaveBeenCalledWith("l/cover.png", MAX_SIGNED_URL_TTL_SECONDS);
    expect(url).toContain("exp=3600");
  });

  it("clamps a longer lifetime to one hour", async () => {
    const { client, methods } = fakeClient();
    await createSignedDownloadUrl(client, BUCKETS.signClips, "water.mp4", 86_400);
    expect(methods.createSignedUrl).toHaveBeenCalledWith("water.mp4", 3600);
  });

  it("keeps a shorter lifetime", async () => {
    const { client, methods } = fakeClient();
    await createSignedDownloadUrl(client, BUCKETS.signClips, "water.mp4", 60.9);
    expect(methods.createSignedUrl).toHaveBeenCalledWith("water.mp4", 60);
  });

  it("rejects a non-positive or invalid lifetime", async () => {
    const { client } = fakeClient();
    await expect(createSignedDownloadUrl(client, BUCKETS.signClips, "x", 0)).rejects.toThrow();
    await expect(createSignedDownloadUrl(client, BUCKETS.signClips, "x", -5)).rejects.toThrow();
    await expect(createSignedDownloadUrl(client, BUCKETS.signClips, "x", NaN)).rejects.toThrow();
  });

  it("surfaces storage errors", async () => {
    const { client } = fakeClient({
      createSignedUrl: vi.fn(async () => ({ data: null, error: { message: "not found" } })),
    });
    await expect(createSignedDownloadUrl(client, BUCKETS.sources, "x")).rejects.toThrow(
      /not found/,
    );
  });
});

describe("paths", () => {
  it("reads extensions case-insensitively", () => {
    expect(fileExtension("Notes.PDF")).toBe("pdf");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
    expect(fileExtension("README")).toBe("");
    expect(fileExtension(".hidden")).toBe("");
    expect(fileExtension("C:\\docs\\lesson.docx")).toBe("docx");
  });

  it.each([
    ["a.pdf", "pdf"],
    ["a.txt", "txt"],
    ["a.md", "md"],
    ["a.docx", "docx"],
    ["a.mp3", "audio"],
    ["a.wav", "audio"],
    ["a.m4a", "audio"],
  ])("maps %s to %s", (name, type) => {
    expect(sourceTypeFromFileName(name)).toBe(type);
  });

  it("rejects unaccepted file types", () => {
    expect(sourceTypeFromFileName("a.exe")).toBeNull();
    expect(sourceTypeFromFileName("a.doc")).toBeNull();
    expect(sourceTypeFromFileName("noext")).toBeNull();
  });

  it("builds source paths without using the original file name", () => {
    expect(sourcePath("user-1", "lesson-1", "My Biology Notes (final).PDF")).toBe(
      "user-1/lesson-1/source.pdf",
    );
  });

  it("refuses unsafe source paths", () => {
    expect(() => sourcePath("user-1", "lesson-1", "a.exe")).toThrow(/Unsupported/);
    expect(() => sourcePath("../etc", "lesson-1", "a.pdf")).toThrow(/Invalid path segment/);
    expect(() => sourcePath("user-1", "a/b", "a.pdf")).toThrow(/Invalid path segment/);
  });

  it("sanitizes media file names and keeps them inside the lesson folder", () => {
    expect(lessonMediaPath("lesson-1", "cover image.png")).toBe("lesson-1/cover_image.png");
    expect(lessonMediaPath("lesson-1", "../../secret.png")).toBe("lesson-1/secret.png");
    expect(() => lessonMediaPath("lesson-1", "...")).toThrow(/Invalid media file name/);
    expect(() => lessonMediaPath("../x", "a.png")).toThrow(/Invalid path segment/);
  });
});
