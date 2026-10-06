import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage helpers (PRD 5.1, 6.4). All buckets are private; files are reached only
 * through signed URLs that expire within an hour.
 */

export const BUCKETS = {
  sources: "sources",
  lessonMedia: "lesson-media",
  signClips: "sign-clips",
} as const;
export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

/** Signed URLs never outlive one hour (PRD 6.4). */
export const MAX_SIGNED_URL_TTL_SECONDS = 3600;

/** Largest accepted upload, from PRD CE-1. Matches the sources bucket limit. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type SourceType = "pdf" | "txt" | "md" | "docx" | "audio";

const SOURCE_TYPES: Record<string, SourceType> = {
  pdf: "pdf",
  txt: "txt",
  md: "md",
  docx: "docx",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
};

/** The extension of an upload, lower case and without the dot, or "" if it has none. */
export function fileExtension(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Maps an upload's file name to a source type, or null if the type is not accepted. */
export function sourceTypeFromFileName(fileName: string): SourceType | null {
  return SOURCE_TYPES[fileExtension(fileName)] ?? null;
}

/**
 * Object path for an uploaded source: {ownerId}/{lessonId}/source.{ext}.
 * The original file name is never used in the path, so nothing user-supplied can
 * escape the folder. Throws if the file type is not accepted.
 */
export function sourcePath(ownerId: string, lessonId: string, fileName: string): string {
  if (!sourceTypeFromFileName(fileName)) {
    throw new Error(`Unsupported file type: ${fileExtension(fileName) || "none"}`);
  }
  assertPathSegment(ownerId);
  assertPathSegment(lessonId);
  return `${ownerId}/${lessonId}/source.${fileExtension(fileName)}`;
}

/** Object path for a lesson media file: {lessonId}/{file}. */
export function lessonMediaPath(lessonId: string, fileName: string): string {
  assertPathSegment(lessonId);
  const safe = (fileName.split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  if (!safe) throw new Error("Invalid media file name");
  return `${lessonId}/${safe}`;
}

function assertPathSegment(segment: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error(`Invalid path segment: ${JSON.stringify(segment)}`);
  }
}

type StorageClient = Pick<SupabaseClient, "storage">;

export interface SignedUpload {
  path: string;
  token: string;
  signedUrl: string;
}

/**
 * A one-time URL the browser can upload to directly. The caller must be allowed to
 * insert at the path (an owner under their own folder, or the service role).
 */
export async function createSignedUploadUrl(
  client: StorageClient,
  bucket: Bucket,
  path: string,
): Promise<SignedUpload> {
  const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(`Could not create upload URL for ${bucket}/${path}: ${error?.message}`);
  }
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

/**
 * A time-limited download URL. The lifetime is clamped to one hour; a non-positive
 * lifetime is a caller bug and throws.
 */
export async function createSignedDownloadUrl(
  client: StorageClient,
  bucket: Bucket,
  path: string,
  expiresInSeconds: number = MAX_SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("expiresInSeconds must be a positive number");
  }
  const ttl = Math.min(Math.floor(expiresInSeconds), MAX_SIGNED_URL_TTL_SECONDS);
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, ttl);
  if (error || !data) {
    throw new Error(`Could not create download URL for ${bucket}/${path}: ${error?.message}`);
  }
  return data.signedUrl;
}
