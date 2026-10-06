"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { getProfileStore, type ProfileStore } from "@/lib/profile/store";
import type { ParseNeedsResponse } from "@/lib/profile/parse-service";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { createBrowserStt } from "@/lib/speech/providers/browser";
import { STT_ERROR_MESSAGES, type SttErrorCode, type SttProvider } from "@/lib/speech/stt";

export type ParseFn = (text: string, profile: RenderProfile) => Promise<ParseNeedsResponse>;

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const defaultParse: ParseFn = async (text, profile) => {
  const response = await fetch("/api/profile/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, profile }),
  });
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after")) || undefined;
    throw new ParseError("That was a lot of requests. Please wait a moment and try again.", retry);
  }
  const json = (await response.json().catch(() => null)) as
    ParseNeedsResponse | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = json && "error" in json ? json.error?.message : undefined;
    throw new ParseError(message ?? "We could not update your settings. Please try again.");
  }
  return json as ParseNeedsResponse;
};

type View =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "proposal"; response: Extract<ParseNeedsResponse, { ok: true }> }
  | { kind: "applied"; response: Extract<ParseNeedsResponse, { ok: true }> }
  | { kind: "undone" }
  | { kind: "message"; text: string; tone: "error" | "info" };

interface NeedsBoxProps {
  profileStore?: StoreApi<ProfileStore>;
  /** Override the network call. Used by tests. */
  parse?: ParseFn;
  /** Speech input. Null turns the microphone off. Defaults to the browser's. */
  speech?: SttProvider | null;
  /** Apply the change as soon as it comes back, with Undo. If false, show Apply first. */
  autoApply?: boolean;
}

/**
 * "Tell Prism what you need": the learner says or types what helps, Prism turns it into
 * settings (PRD CE-4). It shows what it changed in plain language and lets them undo it.
 * Typing is always available; the microphone is an extra, never the only way.
 */
export function NeedsBox({
  profileStore = getProfileStore(),
  parse = defaultParse,
  speech,
  autoApply = true,
}: NeedsBoxProps) {
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const [text, setText] = useState("");
  const [view, setView] = useState<View>({ kind: "idle" });
  const [listening, setListening] = useState(false);
  const [micMessage, setMicMessage] = useState<string | null>(null);
  const [provider] = useState<SttProvider | null>(() =>
    speech === undefined ? (typeof window === "undefined" ? null : createBrowserStt()) : speech,
  );
  const busy = useRef(false);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const canSpeak = provider?.supported === true;

  // Stop listening if the box goes away.
  useEffect(() => () => provider?.abort(), [provider]);

  const submit = async (value: string) => {
    const request = value.trim();
    if (!request || busy.current) return;
    busy.current = true;
    setView({ kind: "working" });
    announce("Updating your settings.");
    try {
      const response = await parse(request, profileStore.getState().profile);
      if (!response.ok) {
        announce(response.message, "assertive");
        setView({ kind: "message", text: response.message, tone: "error" });
        return;
      }
      if (autoApply) {
        profileStore
          .getState()
          .applyProfile(response.profile, { explanation: response.explanation });
        setView({ kind: "applied", response });
      } else {
        setView({ kind: "proposal", response });
      }
      announce(response.explanation);
    } catch (error) {
      const message = error instanceof Error ? error.message : "We could not update your settings.";
      announce(message, "assertive");
      setView({ kind: "message", text: message, tone: "error" });
    } finally {
      busy.current = false;
    }
  };

  const toggleListening = () => {
    if (!provider) return;
    if (listening) {
      provider.stop();
      return;
    }
    setMicMessage(null);
    setListening(true);
    announce("Listening.");
    provider.start({
      onPartial: (partial) => setText(partial),
      onFinal: (final) => {
        setText(final);
        void submit(final);
      },
      onError: (code: SttErrorCode) => {
        if (code === "aborted") return;
        const message = STT_ERROR_MESSAGES[code];
        setMicMessage(message);
        announce(message, "assertive");
      },
      onEnd: () => setListening(false),
    });
  };

  const apply = (response: Extract<ParseNeedsResponse, { ok: true }>) => {
    profileStore.getState().applyProfile(response.profile, { explanation: response.explanation });
    setView({ kind: "applied", response });
    announce("Applied.");
  };

  const undo = () => {
    if (profileStore.getState().undo()) {
      setView({ kind: "undone" });
      announce("Undone. Your settings are back as they were.");
    }
  };

  return (
    <section aria-labelledby={`${fieldId}-heading`} className="flex flex-col gap-4">
      <h2 id={`${fieldId}-heading`} className="text-xl font-semibold">
        Tell Prism what you need
      </h2>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(text);
        }}
      >
        <label htmlFor={fieldId} className="font-medium">
          What would make this easier for you?
        </label>
        <p id={hintId} className="text-muted text-sm">
          For example: &ldquo;I lose focus quickly and like being quizzed&rdquo; or &ldquo;make the
          text bigger and read it to me&rdquo;. You do not need to say why.
        </p>
        <textarea
          id={fieldId}
          value={text}
          rows={3}
          maxLength={1000}
          onChange={(event) => setText(event.target.value)}
          aria-describedby={hintId}
          className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={view.kind === "working" || !text.trim()}>
            {view.kind === "working" ? "Updating…" : "Update my settings"}
          </Button>
          {canSpeak ? (
            <Button
              variant="secondary"
              aria-pressed={listening}
              onClick={toggleListening}
              disabled={view.kind === "working"}
            >
              {listening ? "Stop listening" : "Speak instead"}
            </Button>
          ) : null}
        </div>
        {micMessage ? (
          <p role="status" className="text-danger flex items-start gap-2 font-medium">
            <span aria-hidden="true">⚠</span>
            <span>{micMessage}</span>
          </p>
        ) : null}
      </form>

      <div aria-live="off">
        {view.kind === "message" ? (
          <p
            role={view.tone === "error" ? "alert" : "status"}
            className="flex items-start gap-2 font-medium"
          >
            <span aria-hidden="true">{view.tone === "error" ? "⚠" : "ℹ"}</span>
            <span>{view.text}</span>
          </p>
        ) : null}

        {view.kind === "applied" || view.kind === "proposal" ? (
          <div className="border-line flex flex-col gap-3 rounded-md border p-4">
            <p className="font-medium">{view.response.explanation}</p>
            {view.response.changes.length > 0 ? (
              <>
                <p className="text-sm font-medium">
                  {view.kind === "applied" ? "What changed" : "What would change"}
                </p>
                <ul className="list-disc pl-6">
                  {view.response.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {view.response.unsupported.length > 0 ? (
              <p className="text-muted">
                I cannot do this yet: {view.response.unsupported.join("; ")}. I have noted it so
                Prism can learn what people need.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {view.kind === "proposal" ? (
                <>
                  <Button
                    onClick={() => apply(view.response)}
                    disabled={view.response.changes.length === 0}
                  >
                    Apply
                  </Button>
                  <Button variant="secondary" onClick={() => setView({ kind: "idle" })}>
                    Not now
                  </Button>
                </>
              ) : view.response.changes.length > 0 ? (
                <Button variant="secondary" onClick={undo}>
                  Undo
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {view.kind === "undone" ? (
          <p role="status" className="font-medium">
            Undone. Your settings are back as they were.
          </p>
        ) : null}
      </div>
    </section>
  );
}
