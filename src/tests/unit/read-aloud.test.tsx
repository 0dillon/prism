// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { announce, LiveRegions } from "@/lib/a11y/live-region";
import type { TtsErrorCode, TtsHandlers, TtsOptions, TtsProvider } from "@/lib/speech/tts";
import { TTS_ERROR_MESSAGES } from "@/lib/speech/tts";
import type { ScriptSentence } from "@/renderers/reader/content";
import { ReadAloud } from "@/renderers/reader/ReadAloud";
import { createReadAloudController } from "@/renderers/reader/readAloudController";
import { expectNoAxeViolations } from "../a11y";

vi.mock("@/lib/a11y/live-region", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/a11y/live-region")>();
  return { ...original, announce: vi.fn(original.announce) };
});

/** A speech provider that does nothing until a test says a sentence has finished or failed. */
function fakeTts(supported = true) {
  const spoken: Array<{ text: string; options?: TtsOptions; handlers: TtsHandlers }> = [];
  const provider: TtsProvider & { cancels: number } = {
    supported,
    cancels: 0,
    speak(text, handlers, options) {
      spoken.push({ text, options, handlers });
    },
    cancel() {
      provider.cancels++;
    },
  };
  const last = () => spoken[spoken.length - 1];
  return {
    provider,
    spoken,
    last,
    finish: () => last().handlers.onEnd(),
    fail: (code: TtsErrorCode) => last().handlers.onError?.(code),
  };
}

const script: ScriptSentence[] = [
  { id: "a#0", text: "First." },
  { id: "a#1", text: "Second." },
  { id: "b#0", text: "Third." },
];

function controllerWith(options: { rate?: number; onFinished?: () => void } = {}) {
  const tts = fakeTts();
  const controller = createReadAloudController({ tts: tts.provider, ...options });
  controller.load(script);
  return { controller, ...tts };
}

beforeEach(() => {
  vi.mocked(announce).mockClear();
});

describe("read-aloud controller: playing", () => {
  it("starts idle, with the script loaded", () => {
    const { controller } = controllerWith();
    expect(controller.getState()).toEqual({
      status: "idle",
      index: 0,
      total: 3,
      activeId: null,
      error: null,
    });
  });

  it("reads the first sentence on play and marks it active", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    expect(spoken.map((s) => s.text)).toEqual(["First."]);
    expect(controller.getState()).toMatchObject({ status: "playing", index: 0, activeId: "a#0" });
  });

  it("goes on to the next sentence when one ends, and finishes at the end", () => {
    const onFinished = vi.fn();
    const { controller, finish, spoken } = controllerWith({ onFinished });
    controller.play();
    finish();
    expect(controller.getState()).toMatchObject({ index: 1, activeId: "a#1" });
    finish();
    finish();
    expect(spoken.map((s) => s.text)).toEqual(["First.", "Second.", "Third."]);
    expect(controller.getState()).toMatchObject({ status: "idle", index: 0, activeId: null });
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("does nothing to play an empty script, or when already playing", () => {
    const tts = fakeTts();
    const empty = createReadAloudController({ tts: tts.provider });
    empty.load([]);
    empty.play();
    expect(tts.spoken).toHaveLength(0);

    const { controller, spoken } = controllerWith();
    controller.play();
    controller.play();
    expect(spoken).toHaveLength(1);
  });

  it("passes the rate and language to the voice", () => {
    const tts = fakeTts();
    const controller = createReadAloudController({
      tts: tts.provider,
      rate: 1.5,
      language: "en-GB",
    });
    controller.load(script);
    controller.play();
    expect(tts.last().options).toEqual({ rate: 1.5, language: "en-GB" });
  });

  it("keeps the rate in range", () => {
    const { controller, last } = controllerWith({ rate: 99 });
    controller.play();
    expect(last().options?.rate).toBe(3);
  });
});

describe("read-aloud controller: pause, resume, skip, stop", () => {
  it("pause stops the voice and remembers the sentence", () => {
    const { controller, provider } = controllerWith();
    controller.play();
    const before = provider.cancels;
    controller.pause();
    expect(provider.cancels).toBe(before + 1);
    expect(controller.getState()).toMatchObject({ status: "paused", index: 0, activeId: "a#0" });
  });

  it("resume reads the paused sentence again from its start", () => {
    const { controller, finish, spoken } = controllerWith();
    controller.play();
    finish();
    controller.pause();
    controller.play();
    expect(spoken.map((s) => s.text)).toEqual(["First.", "Second.", "Second."]);
    expect(controller.getState().status).toBe("playing");
  });

  it("toggle switches between playing and paused", () => {
    const { controller } = controllerWith();
    controller.toggle();
    expect(controller.getState().status).toBe("playing");
    controller.toggle();
    expect(controller.getState().status).toBe("paused");
    controller.toggle();
    expect(controller.getState().status).toBe("playing");
  });

  it("a sentence that ends after pause cannot start the next one", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    const stale = spoken[0].handlers.onEnd;
    controller.pause();
    stale();
    expect(spoken).toHaveLength(1);
    expect(controller.getState().status).toBe("paused");
  });

  it("skip moves to the next sentence while playing", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    controller.skip();
    expect(spoken.map((s) => s.text)).toEqual(["First.", "Second."]);
    expect(controller.getState()).toMatchObject({ status: "playing", index: 1 });
  });

  it("a skipped sentence's ending does not skip another", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    const stale = spoken[0].handlers.onEnd;
    controller.skip();
    stale();
    expect(spoken).toHaveLength(2);
    expect(controller.getState().index).toBe(1);
  });

  it("skip while paused moves the place without speaking", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    controller.pause();
    controller.skip();
    expect(spoken).toHaveLength(1);
    expect(controller.getState()).toMatchObject({ status: "paused", index: 1, activeId: "a#1" });
  });

  it("skip past the last sentence finishes", () => {
    const onFinished = vi.fn();
    const { controller } = controllerWith({ onFinished });
    controller.play();
    controller.skip();
    controller.skip();
    controller.skip();
    expect(controller.getState().status).toBe("idle");
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("skip past the last sentence while paused also finishes", () => {
    const onFinished = vi.fn();
    const { controller } = controllerWith({ onFinished });
    controller.play();
    controller.skip();
    controller.skip();
    controller.pause();
    controller.skip();
    expect(controller.getState().status).toBe("idle");
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("skip does nothing when idle", () => {
    const { controller, spoken } = controllerWith();
    controller.skip();
    expect(spoken).toHaveLength(0);
    expect(controller.getState().status).toBe("idle");
  });

  it("stop cancels the voice and goes back to the start", () => {
    const { controller, provider, finish } = controllerWith();
    controller.play();
    finish();
    const before = provider.cancels;
    controller.stop();
    expect(provider.cancels).toBe(before + 1);
    expect(controller.getState()).toMatchObject({ status: "idle", index: 0, activeId: null });
  });

  it("pause does nothing unless playing", () => {
    const { controller, provider } = controllerWith();
    const before = provider.cancels;
    controller.pause();
    expect(provider.cancels).toBe(before);
    expect(controller.getState().status).toBe("idle");
  });
});

describe("read-aloud controller: speed", () => {
  it("a new rate takes effect at once, restarting the sentence being read", () => {
    const { controller, spoken } = controllerWith({ rate: 1 });
    controller.play();
    controller.setRate(2);
    expect(spoken.map((s) => [s.text, s.options?.rate])).toEqual([
      ["First.", 1],
      ["First.", 2],
    ]);
  });

  it("a new rate while paused or idle waits for the next play", () => {
    const { controller, spoken } = controllerWith();
    controller.setRate(2);
    expect(spoken).toHaveLength(0);
    controller.play();
    expect(spoken[0].options?.rate).toBe(2);
  });
});

describe("read-aloud controller: loading and ending", () => {
  it("loading new text stops what was being read", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    const stale = spoken[0].handlers.onEnd;
    controller.load([{ id: "z#0", text: "New." }]);
    stale();
    expect(spoken).toHaveLength(1);
    expect(controller.getState()).toEqual({
      status: "idle",
      index: 0,
      total: 1,
      activeId: null,
      error: null,
    });
  });

  it("dispose stops the voice and ignores later callbacks", () => {
    const { controller, spoken, provider } = controllerWith();
    controller.play();
    const before = provider.cancels;
    controller.dispose();
    spoken[0].handlers.onEnd();
    expect(provider.cancels).toBe(before + 1);
    expect(spoken).toHaveLength(1);
  });

  it("tells subscribers about each change, and not after they leave", () => {
    const { controller, finish } = controllerWith();
    const seen: string[] = [];
    const off = controller.subscribe((s) => seen.push(`${s.status}:${s.index}`));
    controller.play();
    finish();
    off();
    finish();
    expect(seen).toEqual(["playing:0", "playing:1"]);
  });
});

describe("read-aloud controller: errors", () => {
  it("stays on the sentence and pauses, so Play tries it again", () => {
    const { controller, fail, spoken } = controllerWith();
    controller.play();
    fail("blocked");
    expect(controller.getState()).toMatchObject({ status: "paused", index: 0, error: "blocked" });
    controller.play();
    expect(spoken.map((s) => s.text)).toEqual(["First.", "First."]);
    expect(controller.getState().error).toBeNull();
  });

  it("goes idle when speech is not available at all", () => {
    const { controller, fail } = controllerWith();
    controller.play();
    fail("not_supported");
    expect(controller.getState()).toMatchObject({ status: "idle", error: "not_supported" });
  });

  it("ignores an error from a sentence that has been replaced", () => {
    const { controller, spoken } = controllerWith();
    controller.play();
    const stale = spoken[0].handlers.onError!;
    controller.skip();
    stale("unknown");
    expect(controller.getState()).toMatchObject({ status: "playing", error: null });
  });
});

describe("ReadAloud component", () => {
  function Host({
    tts,
    scriptOverride = script,
    onActive = () => {},
  }: {
    tts: TtsProvider | null;
    scriptOverride?: ScriptSentence[];
    onActive?: (id: string | null) => void;
  }) {
    const [rate, setRate] = useState(1);
    return (
      <>
        <ReadAloud
          script={scriptOverride}
          rate={rate}
          onRateChange={setRate}
          onActiveChange={onActive}
          tts={tts}
        />
        <LiveRegions />
      </>
    );
  }

  it("starts with Play and no speech, because the browser needs a tap first", () => {
    const tts = fakeTts();
    render(<Host tts={tts.provider} />);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(tts.spoken).toHaveLength(0);
  });

  it("plays, shows where it is, pauses and resumes", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    render(<Host tts={tts.provider} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(tts.spoken.map((s) => s.text)).toEqual(["First."]);
    expect(screen.getByText("Sentence 1 of 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Sentence 1 of 3, paused")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(tts.spoken).toHaveLength(2);
  });

  it("tells the page which sentence is being read", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    const onActive = vi.fn();
    render(<Host tts={tts.provider} onActive={onActive} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(onActive).toHaveBeenLastCalledWith("a#0");
    act(() => tts.finish());
    expect(onActive).toHaveBeenLastCalledWith("a#1");
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(onActive).toHaveBeenLastCalledWith(null);
  });

  it("skips a sentence", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    render(<Host tts={tts.provider} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    await user.click(screen.getByRole("button", { name: "Skip sentence" }));
    expect(tts.last().text).toBe("Second.");
    expect(screen.getByText("Sentence 2 of 3")).toBeInTheDocument();
  });

  it("disables Skip and Stop until reading has started", () => {
    render(<Host tts={fakeTts().provider} />);
    expect(screen.getByRole("button", { name: "Skip sentence" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  });

  it("disables Play when there is nothing to read", () => {
    render(<Host tts={fakeTts().provider} scriptOverride={[]} />);
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("changes speed from a labelled list, and applies it straight away", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    render(<Host tts={tts.provider} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    await user.selectOptions(screen.getByLabelText("Speed"), "2");
    expect(tts.last().options?.rate).toBe(2);
    expect(tts.last().text).toBe("First.");
  });

  it("offers speeds from 0.5 to 3 times", () => {
    render(<Host tts={fakeTts().provider} />);
    const options = [...(screen.getByLabelText("Speed") as HTMLSelectElement).options].map(
      (o) => o.textContent,
    );
    expect(options[0]).toBe("0.5×");
    expect(options.at(-1)).toBe("3×");
  });

  it("says when it has finished", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    render(<Host tts={tts.provider} scriptOverride={[script[0]]} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    act(() => tts.finish());
    expect(vi.mocked(announce)).toHaveBeenCalledWith("Finished reading.");
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("stops and starts over when the text changes, such as moving to the next idea", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    const { rerender } = render(<Host tts={tts.provider} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    rerender(<Host tts={tts.provider} scriptOverride={[{ id: "n#0", text: "Next page." }]} />);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(tts.provider.cancels).toBeGreaterThan(0);
  });

  it("stops speaking when it leaves the page", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    const { unmount } = render(<Host tts={tts.provider} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    const before = tts.provider.cancels;
    unmount();
    expect(tts.provider.cancels).toBeGreaterThan(before);
  });

  it("explains, and offers no controls, where reading aloud is not available", () => {
    render(<Host tts={null} />);
    expect(screen.getByText(TTS_ERROR_MESSAGES.not_supported)).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains an unsupported provider the same way", () => {
    render(<Host tts={fakeTts(false).provider} />);
    expect(screen.getAllByRole("status")[0]).toHaveTextContent(/not available/);
  });

  it("shows and announces a blocked start, and tries again on Play", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    render(<Host tts={tts.provider} />);
    await user.click(screen.getByRole("button", { name: "Play" }));
    act(() => tts.fail("blocked"));
    expect(screen.getAllByText(TTS_ERROR_MESSAGES.blocked).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(tts.spoken).toHaveLength(2);
  });

  it("can be used by keyboard alone", async () => {
    const user = userEvent.setup();
    const tts = fakeTts();
    render(<Host tts={tts.provider} />);
    await user.tab();
    expect(screen.getByRole("button", { name: "Play" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(tts.spoken).toHaveLength(1);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(tts.last().text).toBe("Second.");
  });

  it("has no axe violations idle or playing", async () => {
    const user = userEvent.setup();
    const { container } = render(<Host tts={fakeTts().provider} />);
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole("button", { name: "Play" }));
    await expectNoAxeViolations(container);
  });
});
