import { describe, expect, it, vi } from "vitest";
import { createSpeechQueue } from "@/renderers/conversation/speechQueue";
import type { TtsErrorCode, TtsHandlers, TtsOptions, TtsProvider } from "@/lib/speech/tts";

function fakeTts() {
  const spoken: Array<{ text: string; options?: TtsOptions; handlers: TtsHandlers }> = [];
  let cancels = 0;
  const provider: TtsProvider = {
    supported: true,
    speak(text, handlers, options) {
      spoken.push({ text, options, handlers });
    },
    cancel() {
      cancels++;
    },
  };
  return {
    provider,
    spoken,
    cancels: () => cancels,
    finish: () => spoken[spoken.length - 1].handlers.onEnd(),
    fail: (code: TtsErrorCode) => spoken[spoken.length - 1].handlers.onError?.(code),
    texts: () => spoken.map((s) => s.text),
  };
}

const make = (tts = fakeTts(), rate = 1) => {
  const onError = vi.fn();
  const queue = createSpeechQueue({
    tts: tts.provider,
    getRate: () => rate,
    language: "en-GB",
    onError,
  });
  return { queue, tts, onError };
};

const settled = async (promise: Promise<boolean>) => {
  let result: boolean | undefined;
  void promise.then((v) => (result = v));
  await Promise.resolve();
  await Promise.resolve();
  return result;
};

describe("say", () => {
  it("speaks one sentence at a time, in order, and resolves true at the end", async () => {
    const { queue, tts } = make();
    const done = queue.say("One. Two. Three.");
    expect(tts.texts()).toEqual(["One."]);
    tts.finish();
    expect(tts.texts()).toEqual(["One.", "Two."]);
    tts.finish();
    tts.finish();
    expect(await done).toBe(true);
    expect(tts.texts()).toEqual(["One.", "Two.", "Three."]);
    expect(queue.speaking).toBe(false);
  });

  it("passes the rate and language to every sentence", () => {
    const { queue, tts } = make(fakeTts(), 1.75);
    void queue.say("A. B.");
    tts.finish();
    expect(tts.spoken.map((s) => s.options)).toEqual([
      { rate: 1.75, language: "en-GB" },
      { rate: 1.75, language: "en-GB" },
    ]);
  });

  it("reads the rate each time, so a change applies from the next sentence", () => {
    const tts = fakeTts();
    let rate = 1;
    const queue = createSpeechQueue({ tts: tts.provider, getRate: () => rate });
    void queue.say("A. B.");
    rate = 2;
    tts.finish();
    expect(tts.spoken.map((s) => s.options?.rate)).toEqual([1, 2]);
  });

  it("resolves true at once for text with nothing to say", async () => {
    const { queue, tts } = make();
    expect(await queue.say("   ")).toBe(true);
    expect(tts.spoken).toHaveLength(0);
  });

  it("reports that it is speaking while it is", () => {
    const { queue, tts } = make();
    expect(queue.speaking).toBe(false);
    void queue.say("Hello.");
    expect(queue.speaking).toBe(true);
    tts.finish();
    expect(queue.speaking).toBe(false);
  });
});

describe("cancel (barge-in)", () => {
  it("stops the voice at once and resolves false", async () => {
    const { queue, tts } = make();
    const done = queue.say("One. Two.");
    const before = tts.cancels();
    queue.cancel();
    expect(tts.cancels()).toBe(before + 1);
    expect(await done).toBe(false);
    expect(queue.speaking).toBe(false);
  });

  it("does not go on to the next sentence when the cancelled one reports it ended", () => {
    const { queue, tts } = make();
    void queue.say("One. Two.");
    const stale = tts.spoken[0].handlers.onEnd;
    queue.cancel();
    stale();
    expect(tts.texts()).toEqual(["One."]);
  });

  it("is safe when nothing is being spoken", () => {
    const { queue } = make();
    expect(() => queue.cancel()).not.toThrow();
  });

  it("starting something new cancels what was being said", async () => {
    const { queue, tts } = make();
    const first = queue.say("Old one. Old two.");
    const second = queue.say("New.");
    expect(await first).toBe(false);
    expect(tts.texts()).toEqual(["Old one.", "New."]);
    tts.finish();
    expect(await second).toBe(true);
  });

  it("an old utterance cannot add text after a new one began", () => {
    const { queue, tts } = make();
    const old = queue.begin();
    queue.begin();
    old.push("Late text. More.");
    old.end();
    expect(tts.spoken).toHaveLength(0);
  });
});

describe("streamed text", () => {
  it("speaks a sentence as soon as it is complete, while the rest is still arriving", () => {
    const { queue, tts } = make();
    const utterance = queue.begin();
    utterance.push("Water rises into the air. Then it");
    expect(tts.texts()).toEqual(["Water rises into the air."]);
    utterance.push(" cools down. And");
    tts.finish();
    expect(tts.texts()).toEqual(["Water rises into the air.", "Then it cools down."]);
  });

  it("holds the last sentence until it is finished or the stream ends", async () => {
    const { queue, tts } = make();
    const utterance = queue.begin();
    utterance.push("Only one sentence so far");
    expect(tts.spoken).toHaveLength(0);
    utterance.end();
    expect(tts.texts()).toEqual(["Only one sentence so far"]);
    tts.finish();
    expect(await utterance.finished).toBe(true);
  });

  it("does not finish until the stream has ended, even if everything so far was spoken", async () => {
    const { queue, tts } = make();
    const utterance = queue.begin();
    utterance.push("First one. Second");
    tts.finish();
    expect(await settled(utterance.finished)).toBeUndefined();
    utterance.push(" part. ");
    utterance.end();
    tts.finish();
    expect(await utterance.finished).toBe(true);
  });

  it("speaks pieces that split a sentence in odd places", () => {
    const { queue, tts } = make();
    const utterance = queue.begin();
    for (const piece of ["Wat", "er mo", "ves. It ri", "ses. Done", "."]) utterance.push(piece);
    utterance.end();
    while (tts.spoken.length < 3) tts.finish();
    expect(tts.texts()).toEqual(["Water moves.", "It rises.", "Done."]);
  });

  it("ignores text pushed after the end", () => {
    const { queue, tts } = make();
    const utterance = queue.begin();
    utterance.push("Done.");
    utterance.end();
    utterance.push("Too late. Really.");
    expect(tts.texts()).toEqual(["Done."]);
  });

  it("finishes at once if the stream ends having said nothing", async () => {
    const { queue } = make();
    const utterance = queue.begin();
    utterance.end();
    expect(await utterance.finished).toBe(true);
  });
});

describe("errors", () => {
  it("stops, tells the owner, and resolves false when speech fails", async () => {
    const { queue, tts, onError } = make();
    const done = queue.say("One. Two.");
    tts.fail("blocked");
    expect(onError).toHaveBeenCalledWith("blocked");
    expect(await done).toBe(false);
    expect(tts.texts()).toEqual(["One."]);
    expect(queue.speaking).toBe(false);
  });

  it("can speak again after a failure", async () => {
    const { queue, tts } = make();
    void queue.say("Fails.");
    tts.fail("unknown");
    const next = queue.say("Works.");
    tts.finish();
    expect(await next).toBe(true);
  });
});
