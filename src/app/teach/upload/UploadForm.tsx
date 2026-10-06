"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { createClient } from "@/lib/supabase/client";
import {
  ACCEPT_HINT,
  ACCEPTED_EXTENSIONS,
  checkFile,
  createDefaultDeps,
  describeState,
  formatSize,
  useUploadFlow,
  type UploadDeps,
} from "./flow";

interface UploadFormProps {
  /** Override the network layer. Used by tests. */
  deps?: UploadDeps;
}

export function UploadForm({ deps }: UploadFormProps) {
  const resolved = useMemo<UploadDeps>(
    () =>
      deps ??
      createDefaultDeps(async (path, token, file) =>
        createClient().storage.from("sources").uploadToSignedUrl(path, token, file),
      ),
    [deps],
  );
  const { state, start, retry, reset } = useUploadFlow(resolved);

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const busy =
    state.phase === "creating" || state.phase === "uploading" || state.phase === "processing";

  // When the lesson finishes or fails, move focus to the result so keyboard and screen
  // reader users land on the next action instead of a button that has since disappeared.
  useEffect(() => {
    if (state.phase === "ready" || state.phase === "failed") resultRef.current?.focus();
  }, [state.phase]);

  const choose = (picked: File | null) => {
    if (!picked) return;
    const problem = checkFile(picked);
    setFile(problem ? null : picked);
    setFileError(problem);
    if (problem) resolved.announce(problem, "assertive");
    else resolved.announce(`Selected ${picked.name}, ${formatSize(picked.size)}.`);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    choose(event.dataTransfer.files[0] ?? null);
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!file) {
      const message = "Choose a file first.";
      setFileError(message);
      resolved.announce(message, "assertive");
      chooseRef.current?.focus();
      return;
    }
    const title = new FormData(event.currentTarget).get("title");
    void start(file, typeof title === "string" ? title : undefined);
  };

  const finished = state.phase === "ready" || state.phase === "failed";

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5" hidden={finished}>
        <TextField
          label="Lesson title (optional)"
          name="title"
          type="text"
          hint="If you leave this blank, Prism uses the file name."
          disabled={busy}
          maxLength={120}
        />

        <div
          role="group"
          aria-labelledby="dropzone-label"
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-start gap-3 rounded-lg border-2 border-dashed p-6 ${
            dragging ? "bg-surface border-accent" : "border-line"
          }`}
        >
          <p id="dropzone-label" className="font-medium">
            Drag a file here, or choose one
          </p>
          <p className="text-muted text-sm">{ACCEPT_HINT}.</p>
          <Button
            ref={chooseRef}
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            Choose a file
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            onChange={(event) => {
              choose(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          {file ? (
            <p>
              Selected: <strong>{file.name}</strong> ({formatSize(file.size)})
            </p>
          ) : null}
          {fileError ? (
            <p role="alert" className="text-danger flex items-start gap-1 font-medium">
              <span aria-hidden="true">⚠</span>
              <span>{fileError}</span>
            </p>
          ) : null}
        </div>

        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : "Upload and process"}
        </Button>
      </form>

      {busy ? (
        <section aria-labelledby="progress-heading" className="flex flex-col gap-2">
          <h2 id="progress-heading" className="text-xl font-semibold">
            Processing {state.fileName}
          </h2>
          <p>{describeState(state)}</p>
          {state.phase === "processing" ? (
            <progress
              max={100}
              value={state.progress}
              aria-label="Processing progress"
              className="h-3 w-full"
            />
          ) : null}
        </section>
      ) : null}

      {finished ? (
        <div ref={resultRef} tabIndex={-1} className="flex flex-col gap-4 outline-none">
          {state.phase === "ready" ? (
            <>
              <h2 className="text-xl font-semibold">Your lesson is ready for review</h2>
              <p>
                Prism has read {state.fileName} and drafted the concepts and quiz questions. Check
                them before learners see anything.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/teach/lessons/${state.lessonId}/review`}
                  className="bg-accent text-accent-foreground inline-flex min-h-11 items-center rounded-md px-4 py-2 font-semibold"
                >
                  Review lesson
                </Link>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFile(null);
                    reset();
                  }}
                >
                  Upload another file
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold">We could not finish this lesson</h2>
              <p role="alert" className="text-danger flex items-start gap-2 font-medium">
                <span aria-hidden="true">⚠</span>
                <span>{state.error}</span>
              </p>
              <div className="flex flex-wrap gap-3">
                {state.lessonId ? <Button onClick={() => void retry()}>Try again</Button> : null}
                <Button
                  variant="secondary"
                  onClick={() => {
                    setFile(null);
                    reset();
                  }}
                >
                  Choose a different file
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
