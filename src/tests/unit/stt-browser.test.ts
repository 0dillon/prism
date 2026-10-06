import { describe, expect, it, vi } from "vitest";
import {
  BrowserStt,
  createBrowserStt,
  findRecognitionConstructor,
} from "@/lib/speech/providers/browser";
import { STT_ERROR_MESSAGES, type SttErrorCode, type SttHandlers } from "@/lib/speech/stt";

/** A stand-in for SpeechRecognition that tests drive by hand. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  throwOnStart = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    if (this.throwOnStart) throw new Error("already started");
    this.started++;
  }
  stop() {
    this.stopped++;
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    this.aborted++;
    queueMicrotask(() => this.onend?.());
  }
  hear(parts: Array<{ text: string; final: boolean }>, resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: parts.map((p) => ({ isFinal: p.final, 0: { transcript: p.text } })),
    });
  }
}

const scope = { SpeechRecognition: FakeRecognition };

function handlers() {
  const calls: string[] = [];
  const h: SttHandlers = {
    onPartial: (t) => calls.push(`partial:${t}`),
    onFinal: (t) => calls.push(`final:${t}`),
    onError: (c) => calls.push(`error:${c}`),
    onEnd: () => calls.push("end"),
  };
  return { h, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("support detection", () => {
  it("finds the standard or the prefixed constructor", () => {
    expect(findRecognitionConstructor({ SpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(findRecognitionConstructor({ webkitSpeechRecognition: FakeRecognition })).toBe(
      FakeRecognition,
    );
    expect(findRecognitionConstructor({})).toBeNull();
  });

  it("reports whether it is supported", () => {
    expect(new BrowserStt(scope).supported).toBe(true);
    expect(new BrowserStt({}).supported).toBe(false);
    expect(createBrowserStt({}).supported).toBe(false);
  });

  it("reports not_supported and ends when started without browser support", () => {
    const { h, calls } = handlers();
    new BrowserStt({}).start(h);
    expect(calls).toEqual(["error:not_supported", "end"]);
  });
});

describe("listening", () => {
  it("configures one utterance with interim results in the requested language", () => {
    const stt = new BrowserStt(scope);
    stt.start(handlers().h, { language: "en-GB" });
    const r = FakeRecognition.last!;
    expect(r).toMatchObject({
      lang: "en-GB",
      continuous: false,
      interimResults: true,
      maxAlternatives: 1,
      started: 1,
    });
  });

  it("defaults to US English", () => {
    new BrowserStt(scope).start(handlers().h);
    expect(FakeRecognition.last!.lang).toBe("en-US");
  });

  it("sends interim text as partials and the finished text once at the end", async () => {
    const { h, calls } = handlers();
    new BrowserStt(scope).start(h);
    const r = FakeRecognition.last!;
    r.hear([{ text: "one idea", final: false }]);
    r.hear([{ text: "one idea at a time", final: true }]);
    r.onend?.();
    expect(calls).toEqual(["partial:one idea", "final:one idea at a time", "end"]);
  });

  it("joins several finished segments", () => {
    const { h, calls } = handlers();
    new BrowserStt(scope).start(h);
    const r = FakeRecognition.last!;
    r.hear([{ text: "bigger text ", final: true }]);
    r.hear(
      [
        { text: "bigger text ", final: true },
        { text: "and quiz me", final: true },
      ],
      1,
    );
    r.onend?.();
    expect(calls.at(-2)).toBe("final:bigger text and quiz me");
  });

  it("reports no_speech when nothing was heard", () => {
    const { h, calls } = handlers();
    new BrowserStt(scope).start(h);
    FakeRecognition.last!.onend?.();
    expect(calls).toEqual(["error:no_speech", "end"]);
  });

  it.each([
    ["not-allowed", "permission_denied"],
    ["service-not-allowed", "permission_denied"],
    ["no-speech", "no_speech"],
    ["audio-capture", "no_microphone"],
    ["network", "network"],
    ["something-new", "unknown"],
  ])(
    "maps the browser error %s to %s, without also reporting a final result",
    (browserError, code) => {
      const { h, calls } = handlers();
      new BrowserStt(scope).start(h);
      const r = FakeRecognition.last!;
      r.onerror?.({ error: browserError });
      r.onend?.();
      expect(calls).toEqual([`error:${code}`, "end"]);
    },
  );

  it("does not report an error for a deliberate abort, and delivers no transcript", async () => {
    const { h, calls } = handlers();
    const stt = new BrowserStt(scope);
    stt.start(h);
    FakeRecognition.last!.hear([{ text: "hello", final: true }]);
    stt.abort();
    await flush();
    expect(calls).toEqual(["end"]);
  });

  it("stop delivers what was heard", async () => {
    const { h, calls } = handlers();
    const stt = new BrowserStt(scope);
    stt.start(h);
    FakeRecognition.last!.hear([{ text: "read it to me", final: true }]);
    stt.stop();
    await flush();
    expect(calls).toEqual(["final:read it to me", "end"]);
  });

  it("ignores a second start while listening, and allows one after it ends", async () => {
    const stt = new BrowserStt(scope);
    stt.start(handlers().h);
    const first = FakeRecognition.last;
    stt.start(handlers().h);
    expect(FakeRecognition.last).toBe(first);
    stt.stop();
    await flush();
    stt.start(handlers().h);
    expect(FakeRecognition.last).not.toBe(first);
  });

  it("reports unknown and ends if the browser refuses to start", () => {
    class Throwing extends FakeRecognition {
      throwOnStart = true;
    }
    const { h, calls } = handlers();
    new BrowserStt({ SpeechRecognition: Throwing }).start(h);
    expect(calls).toEqual(["error:unknown", "end"]);
  });

  it("stop and abort are safe when not listening", () => {
    const stt = new BrowserStt(scope);
    expect(() => {
      stt.stop();
      stt.abort();
    }).not.toThrow();
  });

  it("keeps every handler optional-safe: partials without text are not sent", () => {
    const onPartial = vi.fn();
    new BrowserStt(scope).start({ ...handlers().h, onPartial });
    FakeRecognition.last!.hear([{ text: "", final: false }]);
    expect(onPartial).not.toHaveBeenCalled();
  });
});

describe("error messages", () => {
  it("has a plain message for every error code, none of which blame the learner", () => {
    const codes: SttErrorCode[] = [
      "not_supported",
      "permission_denied",
      "no_speech",
      "no_microphone",
      "network",
      "aborted",
      "unknown",
    ];
    for (const code of codes) {
      expect(STT_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
      expect(STT_ERROR_MESSAGES[code]).not.toMatch(/\b(you failed|your fault|invalid)\b/i);
    }
  });

  it("always offers typing as the way forward when speech fails", () => {
    for (const code of [
      "not_supported",
      "permission_denied",
      "no_speech",
      "no_microphone",
      "network",
      "unknown",
    ] as const) {
      expect(STT_ERROR_MESSAGES[code]).toMatch(/type/i);
    }
  });
});
