// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo } from "react";
import type { StoreApi } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchSessionIntent } from "@/lib/ai/intents/local";
import { LiveRegions } from "@/lib/a11y/live-region";
import { createProfileStore, useProfile, type ProfileStore } from "@/lib/profile/store";
import { createSessionStore, useSession, type SessionStore } from "@/lib/session/store";
import ConversationRenderer from "@/renderers/conversation/ConversationRenderer";
import { createEarconPlayer, EARCON_TONES } from "@/renderers/conversation/earcons";
import {
  ConversationServicesContext,
  guessIntent,
  type ConversationServices,
} from "@/renderers/conversation/services";
import { interpretKey, SHORTCUTS } from "@/renderers/conversation/shortcuts";
import type { SessionActions } from "@/renderers/types";
import { expectNoAxeViolations } from "../a11y";
import { makeGraph } from "../fixtures/graph";

const graph = makeGraph();

function services(over: Partial<ConversationServices> = {}): ConversationServices {
  return {
    resolveIntent: vi.fn(async (u: string) => matchSessionIntent(u) ?? guessIntent(u)),
    tutorTurn: vi.fn(async (_r, { onText }) => {
      onText("Clouds form high up.");
      return "Clouds form high up.";
    }),
    gradeShortAnswer: vi.fn(async () => ({ correct: true })),
    parseNeeds: vi.fn(async () => {
      throw new Error("no");
    }),
    ...over,
  };
}

function Harness({
  sessionStore,
  profileStore,
}: {
  sessionStore: StoreApi<SessionStore>;
  profileStore: StoreApi<ProfileStore>;
}) {
  const session = useSession(sessionStore, (s) => s.session);
  const profile = useProfile((s) => s.profile, profileStore);
  const actions = useMemo<SessionActions>(() => {
    const s = sessionStore.getState();
    return {
      start: s.start,
      next: s.next,
      previous: s.previous,
      requestQuiz: s.requestQuiz,
      answer: s.answer,
      continue: s.continue,
      goTo: s.goTo,
      restart: s.restart,
    };
  }, [sessionStore]);
  return (
    <ConversationRenderer
      graph={graph}
      session={session}
      profile={profile}
      actions={actions}
      updateProfile={(patch) => profileStore.getState().applyPatch(patch)}
    />
  );
}

function setup(options: { svc?: ConversationServices; voice?: boolean } = {}) {
  const profileStore = createProfileStore({ storage: null });
  profileStore.getState().applyPreset("voice_native");
  profileStore.getState().applyPatch({ quiz: { cadence: 5, itemsPerCheck: 1 } });
  const sessionStore = createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 1,
    graph,
    getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
    storage: null,
  });
  const user = userEvent.setup();
  const view = render(
    <ConversationServicesContext.Provider value={options.svc ?? services()}>
      <Harness sessionStore={sessionStore} profileStore={profileStore} />
      <LiveRegions />
    </ConversationServicesContext.Provider>,
  );
  return {
    user,
    sessionStore,
    profileStore,
    session: () => sessionStore.getState().session,
    ...view,
  };
}

const log = () => screen.getByRole("log", { name: "Conversation transcript" });
const status = () => document.querySelector<HTMLElement>("[data-conversation-status]")!;

/** A voice that finishes each sentence at once. */
function stubVoice() {
  const spoken: string[] = [];
  class Utterance {
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onstart: (() => void) | null = null;
    onboundary: (() => void) | null = null;
    lang = "";
    rate = 1;
    voice = null;
    constructor(public text: string) {}
  }
  vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
  vi.stubGlobal("speechSynthesis", {
    speak: (u: Utterance) => {
      spoken.push(u.text);
      setTimeout(() => u.onend?.(), 0);
    },
    cancel: vi.fn(),
    getVoices: () => [],
  });
  return spoken;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ConversationRenderer: with no voice available", () => {
  it("has one h1, a labelled transcript log, a state indicator and a text box", () => {
    const { container } = setup();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 1, name: "The Water Cycle, conversation view" }),
    ).toBeInTheDocument();
    expect(log()).toBeInTheDocument();
    expect(status()).toHaveTextContent("Ready");
    expect(screen.getByLabelText("Type what you want to say")).toBeInTheDocument();
  });

  it("welcomes the learner in the transcript without speaking", () => {
    setup();
    expect(within(log()).getByText(/Welcome\. This lesson is The Water Cycle/)).toBeInTheDocument();
  });

  it("completes a lesson by typing alone", async () => {
    const ctx = setup();
    const input = screen.getByLabelText("Type what you want to say");
    for (const said of ["start", "next", "next", "next", "true", "next"]) {
      await ctx.user.type(input, `${said}{Enter}`);
    }
    await waitFor(() => expect(ctx.session().phase).toBe("complete"));
    expect(within(log()).getByText(/end of the lesson/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lesson complete" })).toBeInTheDocument();
  });

  it("shows what was typed, then the reply, and clears the box", async () => {
    const ctx = setup();
    const input = screen.getByLabelText("Type what you want to say");
    await ctx.user.type(input, "start{Enter}");
    expect(input).toHaveValue("");
    const entries = within(log()).getAllByText(/./, { selector: "p" });
    expect(entries.some((e) => e.textContent === "You: start")).toBe(true);
    expect(await within(log()).findByText(/Evaporation\./)).toBeInTheDocument();
  });

  it("will not send an empty message", () => {
    setup();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("offers the same commands as buttons for each stage", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    for (const name of ["Next", "Repeat", "Simpler", "Quiz me"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    expect(ctx.session().phase).toBe("quiz");
    expect(screen.getByRole("button", { name: "Repeat" })).toBeInTheDocument();
    await ctx.user.type(screen.getByLabelText("Type what you want to say"), "a{Enter}");
    expect(await screen.findByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("offers no microphone or voice buttons where speech is not available", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Speak" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prism's voice/ })).not.toBeInTheDocument();
  });

  it("asks the tutor a question and shows the reply", async () => {
    const svc = services();
    const ctx = setup({ svc });
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await ctx.user.type(
      screen.getByLabelText("Type what you want to say"),
      "why do clouds form up high{Enter}",
    );
    expect(await within(log()).findByText("Clouds form high up.")).toBeInTheDocument();
    expect(svc.tutorTurn).toHaveBeenCalled();
  });

  it("has no axe violations at the start and mid-lesson", async () => {
    const ctx = setup();
    await expectNoAxeViolations(ctx.container, {
      rules: ["landmark-unique", "scrollable-region-focusable"],
    });
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await expectNoAxeViolations(ctx.container, { rules: ["landmark-unique"] });
  });

  it("can be used by keyboard alone", async () => {
    const ctx = setup();
    await ctx.user.tab(); // the transcript, which can be scrolled
    await ctx.user.tab();
    expect(screen.getByLabelText("Type what you want to say")).toHaveFocus();
  });
});

describe("ConversationRenderer: with a voice", () => {
  it("speaks what happens, and says so in the state indicator", async () => {
    const spoken = stubVoice();
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(spoken.join(" ")).toContain("Evaporation. Heat turns liquid water"));
  });

  it("can turn Prism's voice off and still show everything in the transcript", async () => {
    const spoken = stubVoice();
    const ctx = setup();
    const off = screen.getByRole("button", { name: "Turn Prism's voice off" });
    expect(off).toHaveAttribute("aria-pressed", "false");
    await ctx.user.click(off);
    expect(screen.getByRole("button", { name: "Turn Prism's voice on" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    expect(await within(log()).findByText(/Evaporation\./)).toBeInTheDocument();
    expect(spoken).toEqual([]);
  });

  it("stops talking when a key is pressed", async () => {
    stubVoice();
    const cancel = vi.mocked(
      (globalThis as unknown as { speechSynthesis: { cancel: () => void } }).speechSynthesis.cancel,
    );
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    const before = cancel.mock.calls.length;
    await ctx.user.keyboard("x");
    expect(cancel.mock.calls.length).toBeGreaterThanOrEqual(before);
  });

  it("offers a microphone button when voice input is on and the browser can listen", async () => {
    stubVoice();
    class Recognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult = null;
      onerror = null;
      onend = null;
      start() {}
      stop() {}
      abort() {}
    }
    vi.stubGlobal("SpeechRecognition", Recognition);
    setup();
    expect(screen.getByRole("button", { name: "Speak" })).toHaveAttribute("aria-pressed", "false");
  });
});

describe("keyboard shortcuts", () => {
  it("Space pauses and resumes, and R, N, Q and S act on the lesson", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await ctx.user.click(document.body);
    await ctx.user.keyboard("n");
    await waitFor(() => expect(ctx.session().conceptIndex).toBe(1));
    await ctx.user.keyboard("q");
    await waitFor(() => expect(ctx.session().phase).toBe("quiz"));
    await ctx.user.keyboard(" ");
    await waitFor(() => expect(status()).toHaveTextContent("Paused"));
    await ctx.user.keyboard(" ");
    await waitFor(() => expect(status()).not.toHaveTextContent("Paused"));
  });

  it("Space on a button activates the button and nothing else", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    screen.getByRole("button", { name: "Next" }).focus();
    await ctx.user.keyboard(" ");
    expect(ctx.session().conceptIndex).toBe(1);
    expect(status()).not.toHaveTextContent("Paused");
  });

  it("shortcut letters do not fire while typing", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await ctx.user.type(screen.getByLabelText("Type what you want to say"), "nqrs m");
    expect(ctx.session().conceptIndex).toBe(0);
    expect(ctx.session().phase).toBe("learning");
  });

  it("question mark opens a help dialog listing every shortcut, which Escape closes", async () => {
    const ctx = setup();
    await ctx.user.click(document.body);
    await ctx.user.keyboard("?");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const shortcut of SHORTCUTS) {
      expect(within(dialog).getByText(shortcut.description)).toBeInTheDocument();
    }
    await expectNoAxeViolations(dialog);
    await ctx.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has a button to open the help too", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("does not run while the dialog is open", async () => {
    const ctx = setup();
    await ctx.user.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    await screen.findByRole("dialog");
    await ctx.user.keyboard("n");
    expect(ctx.session().phase).toBe("intro");
  });
});

describe("interpretKey", () => {
  const key = (k: string, extra: Record<string, unknown> = {}) =>
    interpretKey({
      key: k,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      repeat: false,
      defaultPrevented: false,
      target: document.body,
      ...extra,
    });

  it("knows each shortcut, in either case", () => {
    for (const s of SHORTCUTS) expect(key(s.key)?.key).toBe(s.key);
    expect(key("R")?.key).toBe("r");
  });

  it("ignores other keys", () => {
    for (const k of ["a", "Enter", "ArrowRight", "Tab"]) expect(key(k)).toBeNull();
  });

  it("ignores a key with Ctrl, Alt or Meta held, a repeat, or one already handled", () => {
    expect(key("r", { ctrlKey: true })).toBeNull();
    expect(key("r", { altKey: true })).toBeNull();
    expect(key("r", { metaKey: true })).toBeNull();
    expect(key("r", { repeat: true })).toBeNull();
    expect(key("r", { defaultPrevented: true })).toBeNull();
  });

  it("ignores keys in text fields, selects and dialogs", () => {
    for (const make of [
      () => document.createElement("input"),
      () => document.createElement("textarea"),
      () => document.createElement("select"),
    ]) {
      const el = make();
      document.body.append(el);
      expect(key("r", { target: el })).toBeNull();
      el.remove();
    }
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inner = document.createElement("div");
    dialog.append(inner);
    document.body.append(dialog);
    expect(key("r", { target: inner })).toBeNull();
    dialog.remove();
  });

  it("leaves Space to buttons and links, but still takes letters from them", () => {
    const button = document.createElement("button");
    document.body.append(button);
    expect(key(" ", { target: button })).toBeNull();
    expect(key("r", { target: button })?.key).toBe("r");
    button.remove();
  });

  it("does not take a checkbox for a text field", () => {
    const box = Object.assign(document.createElement("input"), { type: "checkbox" });
    document.body.append(box);
    expect(key("r", { target: box })?.key).toBe("r");
    box.remove();
  });
});

describe("earcons", () => {
  function fakeContext() {
    const started: Array<{ hz: number; at: number }> = [];
    const context = {
      currentTime: 10,
      destination: {},
      state: "running",
      createOscillator() {
        const osc = {
          frequency: { value: 0 },
          type: "",
          connect() {},
          start(at: number) {
            started.push({ hz: osc.frequency.value, at });
          },
          stop() {},
        };
        return osc;
      },
      createGain: () => ({
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
      }),
    };
    return { context, started };
  }

  it("plays the tones for each kind, one after another", () => {
    const { context, started } = fakeContext();
    const play = createEarconPlayer(() => context);
    play("correct");
    expect(started.map((s) => s.hz)).toEqual(EARCON_TONES.correct.map((t) => t.hz));
    expect(started[1].at).toBeGreaterThan(started[0].at);
  });

  it("has a different sound for listening, right and wrong", () => {
    const sounds = (["listening", "correct", "incorrect"] as const).map((k) =>
      EARCON_TONES[k].map((t) => t.hz).join(","),
    );
    expect(new Set(sounds).size).toBe(3);
  });

  it("makes the audio context once, and only when first used", () => {
    const { context } = fakeContext();
    const make = vi.fn(() => context);
    const play = createEarconPlayer(make);
    expect(make).not.toHaveBeenCalled();
    play("listening");
    play("incorrect");
    expect(make).toHaveBeenCalledTimes(1);
  });

  it("wakes a suspended context", () => {
    const { context } = fakeContext();
    const resume = vi.fn(async () => {});
    const play = createEarconPlayer(() => ({ ...context, state: "suspended", resume }));
    play("correct");
    expect(resume).toHaveBeenCalled();
  });

  it("stays silent, without an error, when there is no audio or it fails", () => {
    expect(() => createEarconPlayer(() => null)("correct")).not.toThrow();
    const broken = createEarconPlayer(() => {
      throw new Error("no audio");
    });
    expect(() => broken("correct")).not.toThrow();
  });
});

describe("earcons in the lesson", () => {
  it("are not played unless the learner turned them on", async () => {
    const context = vi.fn();
    vi.stubGlobal("AudioContext", context);
    const ctx = setup();
    act(() => void ctx.profileStore.getState().applyPatch({ audio: { earcons: false } }));
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    await ctx.user.type(screen.getByLabelText("Type what you want to say"), "a{Enter}");
    expect(context).not.toHaveBeenCalled();
  });

  it("are played for a result when the setting is on", async () => {
    const instances: unknown[] = [];
    vi.stubGlobal(
      "AudioContext",
      class {
        currentTime = 0;
        destination = {};
        state = "running";
        constructor() {
          instances.push(this);
        }
        createOscillator() {
          return { frequency: { value: 0 }, type: "", connect() {}, start() {}, stop() {} };
        }
        createGain() {
          return {
            gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {},
          };
        }
      },
    );
    const ctx = setup();
    act(() => void ctx.profileStore.getState().applyPatch({ audio: { earcons: true } }));
    await ctx.user.click(screen.getByRole("button", { name: "Start" }));
    await ctx.user.click(screen.getByRole("button", { name: "Quiz me" }));
    await ctx.user.type(screen.getByLabelText("Type what you want to say"), "a{Enter}");
    await waitFor(() => expect(instances.length).toBe(1));
  });
});
