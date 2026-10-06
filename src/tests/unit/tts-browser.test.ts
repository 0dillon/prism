import { describe, expect, it, vi } from "vitest";
import { BrowserTts, createBrowserTts } from "@/lib/speech/providers/browser";
import {
  clampRate,
  MAX_RATE,
  MIN_RATE,
  TTS_ERROR_MESSAGES,
  type TtsHandlers,
} from "@/lib/speech/tts";

class FakeUtterance {
  static all: FakeUtterance[] = [];
  lang = "";
  rate = 1;
  voice: unknown = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onboundary: ((event: { name?: string; charIndex: number; charLength?: number }) => void) | null =
    null;
  constructor(public text: string) {
    FakeUtterance.all.push(this);
  }
}

function fakeSynthesis(
  voices: Array<{ lang: string; localService?: boolean; name?: string }> = [],
) {
  const spoken: FakeUtterance[] = [];
  return {
    spoken,
    cancelled: 0,
    throwOnSpeak: false,
    speak(utterance: FakeUtterance) {
      if (this.throwOnSpeak) throw new Error("nope");
      spoken.push(utterance);
    },
    cancel() {
      this.cancelled++;
    },
    getVoices: () => voices,
  };
}

function make(synthesis = fakeSynthesis()) {
  const tts = new BrowserTts({
    speechSynthesis: synthesis,
    SpeechSynthesisUtterance: FakeUtterance,
  });
  return { tts, synthesis };
}

function handlers() {
  const calls: string[] = [];
  const h: TtsHandlers = {
    onStart: () => calls.push("start"),
    onBoundary: (b) => calls.push(`boundary:${b.kind}:${b.charIndex}:${b.charLength ?? ""}`),
    onEnd: () => calls.push("end"),
    onError: (c) => calls.push(`error:${c}`),
  };
  return { h, calls };
}

describe("BrowserTts: support", () => {
  it("is supported only when both speechSynthesis and the utterance class exist", () => {
    expect(make().tts.supported).toBe(true);
    expect(new BrowserTts({}).supported).toBe(false);
    expect(new BrowserTts({ speechSynthesis: fakeSynthesis() }).supported).toBe(false);
    expect(createBrowserTts({}).supported).toBe(false);
  });

  it("reports not_supported without throwing when it cannot speak", () => {
    const { h, calls } = handlers();
    new BrowserTts({}).speak("hello", h);
    expect(calls).toEqual(["error:not_supported"]);
  });

  it("does not throw on cancel when unsupported", () => {
    expect(() => new BrowserTts({}).cancel()).not.toThrow();
  });
});

describe("BrowserTts: speaking", () => {
  it("speaks the text at the given rate and language", () => {
    const { tts, synthesis } = make();
    tts.speak("Water moves.", handlers().h, { rate: 1.5, language: "en-GB" });
    expect(synthesis.spoken).toHaveLength(1);
    expect(synthesis.spoken[0]).toMatchObject({ text: "Water moves.", rate: 1.5, lang: "en-GB" });
  });

  it("defaults to normal speed and US English", () => {
    const { tts, synthesis } = make();
    tts.speak("Hi.", handlers().h);
    expect(synthesis.spoken[0]).toMatchObject({ rate: 1, lang: "en-US" });
  });

  it("keeps the rate inside what the settings allow", () => {
    const { tts, synthesis } = make();
    tts.speak("a", handlers().h, { rate: 99 });
    tts.speak("b", handlers().h, { rate: 0 });
    tts.speak("c", handlers().h, { rate: Number.NaN });
    expect(synthesis.spoken.map((u) => u.rate)).toEqual([MAX_RATE, MIN_RATE, 1]);
  });

  it("stops what was being spoken before it starts the next", () => {
    const { tts, synthesis } = make();
    tts.speak("one", handlers().h);
    tts.speak("two", handlers().h);
    expect(synthesis.cancelled).toBe(2);
  });

  it("passes start, boundary and end through, in order", () => {
    const { tts, synthesis } = make();
    const { h, calls } = handlers();
    tts.speak("Hello there", h);
    const u = synthesis.spoken[0];
    u.onstart?.();
    u.onboundary?.({ name: "word", charIndex: 0, charLength: 5 });
    u.onboundary?.({ name: "sentence", charIndex: 0 });
    u.onboundary?.({ charIndex: 6, charLength: 5 });
    u.onend?.();
    expect(calls).toEqual([
      "start",
      "boundary:word:0:5",
      "boundary:sentence:0:",
      "boundary:word:6:5",
      "end",
    ]);
  });

  it("works when the caller gave only the required handler", () => {
    const { tts, synthesis } = make();
    const onEnd = vi.fn();
    tts.speak("x", { onEnd });
    const u = synthesis.spoken[0];
    expect(() => {
      u.onstart?.();
      u.onboundary?.({ charIndex: 0 });
      u.onerror?.({ error: "synthesis-failed" });
    }).not.toThrow();
    u.onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});

describe("BrowserTts: stopping", () => {
  it("cancel stops speech and silences the callbacks of what was being spoken", () => {
    const { tts, synthesis } = make();
    const { h, calls } = handlers();
    tts.speak("Hello", h);
    const u = synthesis.spoken[0];
    tts.cancel();
    u.onstart?.();
    u.onboundary?.({ charIndex: 0 });
    u.onend?.();
    u.onerror?.({ error: "synthesis-failed" });
    expect(calls).toEqual([]);
    expect(synthesis.cancelled).toBeGreaterThanOrEqual(2);
  });

  it("does not let a stopped sentence report that it ended after the next one began", () => {
    const { tts, synthesis } = make();
    const first = handlers();
    const second = handlers();
    tts.speak("one", first.h);
    tts.speak("two", second.h);
    synthesis.spoken[0].onend?.(); // the browser reports the old one late
    expect(first.calls).toEqual([]);
    synthesis.spoken[1].onend?.();
    expect(second.calls).toEqual(["end"]);
  });

  it.each(["canceled", "cancelled", "interrupted"])(
    "does not treat the browser's '%s' as a failure",
    (reason) => {
      const { tts, synthesis } = make();
      const { h, calls } = handlers();
      tts.speak("x", h);
      synthesis.spoken[0].onerror?.({ error: reason });
      expect(calls).toEqual([]);
    },
  );
});

describe("BrowserTts: errors", () => {
  it("reports blocked when the browser wants a tap first", () => {
    const { tts, synthesis } = make();
    const { h, calls } = handlers();
    tts.speak("x", h);
    synthesis.spoken[0].onerror?.({ error: "not-allowed" });
    expect(calls).toEqual(["error:blocked"]);
  });

  it("reports unknown for any other failure", () => {
    const { tts, synthesis } = make();
    const { h, calls } = handlers();
    tts.speak("x", h);
    synthesis.spoken[0].onerror?.({ error: "synthesis-failed" });
    synthesis.spoken[0].onerror?.({});
    expect(calls).toEqual(["error:unknown", "error:unknown"]);
  });

  it("reports unknown, and does not throw, if the browser refuses to speak", () => {
    const synthesis = fakeSynthesis();
    synthesis.throwOnSpeak = true;
    const { tts } = make(synthesis);
    const { h, calls } = handlers();
    expect(() => tts.speak("x", h)).not.toThrow();
    expect(calls).toEqual(["error:unknown"]);
  });

  it("has a plain message for every error, and none that blames the learner", () => {
    for (const code of ["not_supported", "blocked", "unknown"] as const) {
      expect(TTS_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
      expect(TTS_ERROR_MESSAGES[code]).not.toMatch(/\b(you failed|your fault|invalid)\b/i);
    }
  });
});

describe("BrowserTts: choosing a voice", () => {
  const voices = [
    { lang: "fr-FR", localService: true, name: "fr" },
    { lang: "en-GB", localService: false, name: "gb-network" },
    { lang: "en-US", localService: false, name: "us-network" },
    { lang: "en-US", localService: true, name: "us-local" },
    { lang: "en-AU", localService: true, name: "au-local" },
  ];
  const chosen = (language: string | undefined, list = voices) => {
    const { tts, synthesis } = make(fakeSynthesis(list));
    tts.speak("x", handlers().h, { language });
    return (synthesis.spoken[0].voice as { name?: string } | null)?.name ?? null;
  };

  it("prefers an exact language match that is on this device", () => {
    expect(chosen("en-US")).toBe("us-local");
  });

  it("falls back to another dialect of the language, on this device if it can", () => {
    expect(chosen("en-NZ")).toBe("us-local");
  });

  it("uses an exact match from the network over a different dialect on the device", () => {
    expect(chosen("en-GB")).toBe("gb-network");
  });

  it("picks no voice for a language with none, leaving the browser's default", () => {
    expect(chosen("de-DE")).toBeNull();
  });

  it("copes with no voices loaded yet", () => {
    expect(chosen("en-US", [])).toBeNull();
  });

  it("copes with the voice list failing", () => {
    const synthesis = fakeSynthesis();
    synthesis.getVoices = () => {
      throw new Error("not ready");
    };
    const { tts } = make(synthesis);
    expect(() => tts.speak("x", handlers().h)).not.toThrow();
  });
});

describe("clampRate", () => {
  it("passes through a valid rate and limits the rest", () => {
    expect(clampRate(1.25)).toBe(1.25);
    expect(clampRate(10)).toBe(MAX_RATE);
    expect(clampRate(-1)).toBe(MIN_RATE);
    expect(clampRate(Infinity)).toBe(1);
  });
});
