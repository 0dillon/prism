import { useCallback, useEffect, useRef, useState } from "react";
import { announce } from "@/lib/a11y/live-region";
import { MAX_UPLOAD_BYTES, sourceTypeFromFileName } from "@/lib/supabase/storage";

/**
 * The upload flow (PRD CE-1): create the lesson, upload the file straight to storage,
 * start processing, then poll until the lesson is ready for review. Stage changes are
 * announced through the global live region, so a keyboard or screen reader user hears
 * the same progress a sighted user sees.
 */

export type UploadPhase = "idle" | "creating" | "uploading" | "processing" | "ready" | "failed";

export interface UploadState {
  phase: UploadPhase;
  lessonId: string | null;
  fileName: string | null;
  stageLabel: string | null;
  /** 0 to 100 while processing. */
  progress: number;
  error: string | null;
}

export const INITIAL_STATE: UploadState = {
  phase: "idle",
  lessonId: null,
  fileName: null,
  stageLabel: null,
  progress: 0,
  error: null,
};

export interface CreateResponse {
  lessonId: string;
  jobId: string;
  upload: { path: string; token: string };
}

export interface StatusResponse {
  stageLabel: string;
  progress: number;
  error: string | null;
  ready: boolean;
}

export interface UploadDeps {
  createLesson(input: {
    fileName: string;
    fileSize: number;
    title?: string;
  }): Promise<CreateResponse>;
  uploadFile(upload: { path: string; token: string }, file: File): Promise<void>;
  startIngest(lessonId: string): Promise<void>;
  getStatus(lessonId: string): Promise<StatusResponse>;
  announce(message: string, priority?: "polite" | "assertive"): void;
  sleep(ms: number): Promise<void>;
  pollIntervalMs: number;
  /** Give up waiting after this long and tell the user to check back. */
  maxWaitMs: number;
}

export const ACCEPTED_EXTENSIONS = ".pdf,.txt,.md";
export const ACCEPT_HINT = "PDF, TXT, or Markdown, up to 50 MB";

/** A message for a file the user picked that cannot be used, or null if it is fine. */
export function checkFile(file: { name: string; size: number }): string | null {
  const type = sourceTypeFromFileName(file.name);
  if (type === null) return "That file type is not accepted. Use a PDF, TXT, or Markdown file.";
  if (type === "audio")
    return "Audio files are not supported yet. Use a PDF, TXT, or Markdown file.";
  if (type === "docx")
    return "Word documents are not supported yet. Use a PDF, TXT, or Markdown file.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_UPLOAD_BYTES) return "That file is larger than 50 MB.";
  return null;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MAX_POLL_FAILURES = 4;

/** Drives the flow. `deps` is injectable so tests can run it without a network. */
export function useUploadFlow(deps: UploadDeps) {
  const [state, setState] = useState<UploadState>(INITIAL_STATE);
  const cancelled = useRef(false);
  const depsRef = useRef(deps);

  useEffect(() => {
    depsRef.current = deps;
  }, [deps]);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const fail = useCallback((message: string, lessonId: string | null) => {
    depsRef.current.announce(`Processing failed. ${message}`, "assertive");
    setState((current) => ({
      ...current,
      phase: "failed",
      lessonId,
      error: message,
      stageLabel: null,
    }));
  }, []);

  const poll = useCallback(
    async (lessonId: string) => {
      const d = depsRef.current;
      const startedAt = Date.now();
      let lastLabel: string | null = null;
      let failures = 0;

      while (!cancelled.current) {
        if (Date.now() - startedAt > d.maxWaitMs) {
          fail(
            "This is taking longer than expected. Check the lesson list again in a few minutes.",
            lessonId,
          );
          return;
        }
        try {
          const status = await d.getStatus(lessonId);
          failures = 0;
          if (cancelled.current) return;

          if (status.error) {
            fail(status.error, lessonId);
            return;
          }
          if (status.ready) {
            d.announce("Your lesson is ready for review.");
            setState((current) => ({
              ...current,
              phase: "ready",
              stageLabel: status.stageLabel,
              progress: 100,
              error: null,
            }));
            return;
          }
          if (status.stageLabel !== lastLabel) {
            lastLabel = status.stageLabel;
            d.announce(status.stageLabel);
          }
          setState((current) => ({
            ...current,
            phase: "processing",
            stageLabel: status.stageLabel,
            progress: status.progress,
          }));
        } catch {
          // A single failed poll is not a failed lesson. Keep trying a few times.
          failures += 1;
          if (failures >= MAX_POLL_FAILURES) {
            fail("We lost contact with the server. Check your connection and try again.", lessonId);
            return;
          }
        }
        await d.sleep(d.pollIntervalMs);
      }
    },
    [fail],
  );

  const start = useCallback(
    async (file: File, title?: string) => {
      const d = depsRef.current;
      const problem = checkFile(file);
      if (problem) {
        d.announce(problem, "assertive");
        setState({ ...INITIAL_STATE, phase: "failed", fileName: file.name, error: problem });
        return;
      }

      let lessonId: string | null = null;
      try {
        setState({ ...INITIAL_STATE, phase: "creating", fileName: file.name });
        d.announce("Preparing your upload.");
        const created = await d.createLesson({
          fileName: file.name,
          fileSize: file.size,
          title: title?.trim() || undefined,
        });
        lessonId = created.lessonId;

        setState((s) => ({ ...s, phase: "uploading", lessonId }));
        d.announce("Uploading your file.");
        await d.uploadFile(created.upload, file);

        await d.startIngest(lessonId);
        setState((s) => ({ ...s, phase: "processing", progress: 0, stageLabel: "Starting" }));
        d.announce("Upload complete. Processing has started.");
        await poll(lessonId);
      } catch (error) {
        fail(
          error instanceof Error ? error.message : "Something went wrong. Please try again.",
          lessonId,
        );
      }
    },
    [fail, poll],
  );

  /** Resumes a failed lesson from the step that failed, without uploading again. */
  const retry = useCallback(async () => {
    const lessonId = state.lessonId;
    if (!lessonId) return;
    const d = depsRef.current;
    try {
      setState((s) => ({
        ...s,
        phase: "processing",
        error: null,
        stageLabel: "Starting",
        progress: 0,
      }));
      d.announce("Trying again.");
      await d.startIngest(lessonId);
      await poll(lessonId);
    } catch (error) {
      fail(
        error instanceof Error ? error.message : "Something went wrong. Please try again.",
        lessonId,
      );
    }
  }, [fail, poll, state.lessonId]);

  const reset = useCallback(() => setState(INITIAL_STATE), []);

  return { state, start, retry, reset };
}

/** Plain-language status line for the current state. */
export function describeState(state: UploadState): string {
  switch (state.phase) {
    case "idle":
      return "";
    case "creating":
      return "Preparing your upload";
    case "uploading":
      return "Uploading your file";
    case "processing":
      return `${state.stageLabel ?? "Processing"}, ${state.progress} percent`;
    case "ready":
      return "Ready for review";
    case "failed":
      return "Something went wrong";
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch {
    // Fall through to the generic message.
  }
  return "Something went wrong. Please try again.";
}

/** The real dependencies: the app's own API and Supabase Storage. */
export function createDefaultDeps(
  uploadToSignedUrl: (
    path: string,
    token: string,
    file: File,
  ) => Promise<{ error: { message: string } | null }>,
): UploadDeps {
  return {
    async createLesson(input) {
      const response = await fetch("/api/lessons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as CreateResponse;
    },
    async uploadFile(upload, file) {
      const { error } = await uploadToSignedUrl(upload.path, upload.token, file);
      if (error) throw new Error("The upload did not finish. Check your connection and try again.");
    },
    async startIngest(lessonId) {
      const response = await fetch(`/api/lessons/${lessonId}/ingest`, { method: "POST" });
      if (!response.ok) throw new Error(await readError(response));
    },
    async getStatus(lessonId) {
      const response = await fetch(`/api/lessons/${lessonId}/status`, { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      return (await response.json()) as StatusResponse;
    },
    announce,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollIntervalMs: 2000,
    maxWaitMs: 15 * 60 * 1000,
  };
}
