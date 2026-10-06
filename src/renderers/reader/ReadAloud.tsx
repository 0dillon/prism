"use client";

import { useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { createBrowserTts } from "@/lib/speech/providers/browser";
import { TTS_ERROR_MESSAGES, type TtsProvider } from "@/lib/speech/tts";
import type { ScriptSentence } from "./content";
import { createReadAloudController } from "./readAloudController";

export const RATE_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;

interface ReadAloudProps {
  script: readonly ScriptSentence[];
  rate: number;
  onRateChange: (rate: number) => void;
  /** The sentence being read, or null. The reader uses it for the highlight. */
  onActiveChange: (id: string | null) => void;
  /** Speech provider. Null means none is available. Defaults to the browser's. */
  tts?: TtsProvider | null;
}

const EMPTY = { status: "idle", index: 0, total: 0, activeId: null, error: null } as const;

const formatRate = (rate: number) => `${rate}×`;

/**
 * Read-aloud controls (PRD 5.6.2): play or pause, skip a sentence, stop and change the
 * speed. It speaks one sentence at a time and reports which one, so the page can
 * highlight it. Speech starts only when the learner presses Play, since browsers do not
 * allow a page to start talking by itself.
 */
export function ReadAloud({ script, rate, onRateChange, onActiveChange, tts }: ReadAloudProps) {
  const labelId = useId();
  const speed = useId();
  const provider = useMemo<TtsProvider | null>(
    () => (tts === undefined ? (typeof window === "undefined" ? null : createBrowserTts()) : tts),
    [tts],
  );

  const controller = useMemo(
    () =>
      provider
        ? createReadAloudController({
            tts: provider,
            rate,
            onFinished: () => announce("Finished reading."),
          })
        : null,
    // The controller is rebuilt only with the provider. Rate changes go through setRate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [provider],
  );

  const state = useSyncExternalStore(
    (listener) => controller?.subscribe(listener) ?? (() => {}),
    () => controller?.getState() ?? EMPTY,
    () => EMPTY,
  );

  // New text means a new page: stop and start from the top.
  const scriptKey = useMemo(() => script.map((s) => s.id).join("|"), [script]);
  useEffect(() => {
    controller?.load(script);
    // `script` is covered by `scriptKey`, which changes whenever its sentences do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, scriptKey]);

  useEffect(() => () => controller?.dispose(), [controller]);
  useEffect(() => controller?.setRate(rate), [controller, rate]);
  useEffect(() => onActiveChange(state.activeId), [state.activeId, onActiveChange]);

  const lastError = useRef<string | null>(null);
  useEffect(() => {
    if (state.error && lastError.current !== state.error) announce(TTS_ERROR_MESSAGES[state.error]);
    lastError.current = state.error;
  }, [state.error]);

  if (!provider?.supported) {
    return (
      <p role="status" className="text-muted">
        {TTS_ERROR_MESSAGES.not_supported}
      </p>
    );
  }

  const playing = state.status === "playing";
  const idle = state.status === "idle";
  const empty = script.length === 0;

  return (
    <section
      aria-labelledby={labelId}
      className="border-line flex flex-col gap-3 rounded-md border p-4"
    >
      <h2 id={labelId} className="font-semibold">
        Read aloud
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => {
            controller?.toggle();
            announce(playing ? "Paused." : "Reading aloud.");
          }}
          disabled={empty}
        >
          {playing ? "Pause" : state.status === "paused" ? "Resume" : "Play"}
        </Button>
        <Button variant="secondary" onClick={() => controller?.skip()} disabled={idle}>
          Skip sentence
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            controller?.stop();
            announce("Stopped.");
          }}
          disabled={idle}
        >
          Stop
        </Button>
        <div className="flex items-center gap-2">
          <label htmlFor={speed} className="font-medium">
            Speed
          </label>
          <select
            id={speed}
            value={RATE_CHOICES.includes(rate as (typeof RATE_CHOICES)[number]) ? rate : 1}
            onChange={(event) => onRateChange(Number(event.target.value))}
            className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
          >
            {RATE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {formatRate(choice)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {!idle ? (
        <p className="text-muted text-sm">
          Sentence {state.index + 1} of {state.total}
          {state.status === "paused" ? ", paused" : ""}
        </p>
      ) : null}
      {state.error ? (
        <p role="status" className="font-medium">
          {TTS_ERROR_MESSAGES[state.error]}
        </p>
      ) : null}
    </section>
  );
}
