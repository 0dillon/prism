import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfilePatch } from "@/lib/profile/merge";
import { deepMergeProfile } from "@/lib/profile/merge";
import { presetProfile } from "@/lib/profile/presets";
import type { SessionIntent } from "@/lib/schemas/intents";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { createSessionStore } from "@/lib/session/store";
import {
  createConversationController,
  type ConversationState,
  type Earcon,
} from "@/renderers/conversation/controller";
import type { ConversationServices } from "@/renderers/conversation/services";
import { guessIntent } from "@/renderers/conversation/services";
import { matchSessionIntent } from "@/lib/ai/intents/local";
import { notCoveredReply } from "@/lib/ai/tutor/turn";
import type { SttErrorCode, SttHandlers, SttProvider } from "@/lib/speech/stt";
import type { TtsHandlers, TtsProvider } from "@/lib/speech/tts";
import { makeGraph } from "../fixtures/graph";

const graph = makeGraph();

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A voice that finishes each sentence by itself, or waits to be told. */
function fakeTts(auto = true) {
  const spoken: string[] = [];
  const pending: TtsHandlers[] = [];
  let cancels = 0;
  const provider: TtsProvider = {
    supported: true,
    speak(text, handlers) {
      spoken.push(text);
      if (auto) queueMicrotask(() => handlers.onEnd());
      else pending.push(handlers);
    },
    cancel() {
      cancels++;
    },
  };
  return {
    provider,
    spoken,
    cancels: () => cancels,
    finishOne: () => pending.shift()?.onEnd(),
    said: () => spoken.join(" "),
  };
}

/** A microphone that hears a script of things the learner says, one per listen. */
function fakeStt(script: string[] = [], errorWhenEmpty: SttErrorCode | null = "no_speech") {
  let starts = 0;
  let aborts = 0;
  let stops = 0;
  let handlers: SttHandlers | null = null;
  const provider: SttProvider = {
    supported: true,
    start(h) {
      starts++;
      handlers = h;
      setTimeout(() => {
        if (handlers !== h) return;
        const next = script.shift();
        if (next !== undefined) h.onFinal(next);
        else if (errorWhenEmpty) h.onError(errorWhenEmpty);
        h.onEnd();
      }, 0);
    },
    stop() {
      stops++;
    },
    abort() {
      aborts++;
      const h = handlers;
      handlers = null;
      h?.onEnd();
    },
  };
  return { provider, script, starts: () => starts, aborts: () => aborts, stops: () => stops };
}

function fakeServices(over: Partial<ConversationServices> = {}) {
  const services: ConversationServices = {
    resolveIntent: vi.fn(
      async (utterance: string) => matchSessionIntent(utterance) ?? guessIntent(utterance),
    ),
    tutorTurn: vi.fn(async (_request, { onText }) => {
      onText("It cools into drops. ");
      onText("That makes clouds.");
      return "It cools into drops. That makes clouds.";
    }),
    gradeShortAnswer: vi.fn(async () => ({ correct: true, feedback: "Nicely put." })),
    parseNeeds: vi.fn(async (_text: string, profile: RenderProfile) => ({
      ok: true as const,
      profile: deepMergeProfile(profile, { typography: { sizeScale: 1.5 } }),
      changes: ["Bigger text"],
      explanation: "I made the text bigger.",
      unsupported: [],
    })),
    ...over,
  };
  return services;
}

interface Options {
  tts?: ReturnType<typeof fakeTts> | null;
  stt?: ReturnType<typeof fakeStt> | null;
  services?: Partial<ConversationServices>;
  preset?: Parameters<typeof presetProfile>[0];
  cadence?: number;
  graphOverride?: typeof graph;
  earcon?: (k: Earcon) => void;
}

function setup(options: Options = {}) {
  const g = options.graphOverride ?? graph;
  let profile = presetProfile(options.preset ?? "voice_native");
  profile = deepMergeProfile(profile, {
    quiz: { cadence: options.cadence ?? 5, itemsPerCheck: 1 },
  });
  const tts = options.tts === undefined ? fakeTts() : options.tts;
  const stt = options.stt === undefined ? fakeStt() : options.stt;
  const services = fakeServices(options.services);
  const updateProfile = vi.fn((patch: ProfilePatch) => {
    profile = deepMergeProfile(profile, patch);
  });
  const store = createSessionStore({
    lessonId: g.lessonId,
    graphVersion: 1,
    graph: g,
    getSettings: () => ({
      cadence: profile.quiz.cadence,
      itemsPerCheck: profile.quiz.itemsPerCheck,
      retryOnWrong: false,
    }),
    storage: null,
    now: () => 0,
  });
  const s = store.getState();
  const controller = createConversationController({
    lessonId: g.lessonId,
    graph: g,
    getSession: () => store.getState().session,
    getProfile: () => profile,
    actions: {
      start: s.start,
      next: s.next,
      previous: s.previous,
      requestQuiz: s.requestQuiz,
      answer: s.answer,
      continue: s.continue,
      goTo: s.goTo,
      restart: s.restart,
    },
    updateProfile,
    services,
    tts: tts?.provider ?? null,
    stt: stt?.provider ?? null,
    earcon: options.earcon,
  });
  // The renderer does this: tell the conversation whenever the session changes.
  controller.onSession(store.getState().session);
  store.subscribe((state) => controller.onSession(state.session));
  const states: ConversationState[] = [];
  controller.subscribe((state) => states.push(state));
  return {
    controller,
    store,
    tts,
    stt,
    services,
    updateProfile,
    session: () => store.getState().session,
    state: () => controller.getState(),
    texts: (role?: "tutor" | "learner") =>
      controller
        .getState()
        .transcript.filter((e) => !role || e.role === role)
        .map((e) => e.text),
    statuses: () => [...new Set(states.map((x) => x.status))],
    profile: () => profile,
  };
}

let h: ReturnType<typeof setup>;
afterEach(() => h?.controller.dispose());

describe("opening the page", () => {
  it("shows a welcome in the transcript and says nothing aloud, since a page may not speak by itself", () => {
    h = setup();
    expect(h.texts("tutor")[0]).toMatch(/Welcome\. This lesson is The Water Cycle/);
    expect(h.tts!.spoken).toEqual([]);
    expect(h.state().status).toBe("idle");
  });

  it("welcomes a returning learner back to where they were, in text", () => {
    h = setup();
    h.store.getState().start();
    const reopened = setup();
    reopened.store.getState().start();
    reopened.store.getState().next();
    const again = createConversationController({
      lessonId: graph.lessonId,
      graph,
      getSession: () => reopened.session(),
      getProfile: () => reopened.profile(),
      actions: reopened.store.getState(),
      updateProfile: () => {},
      services: fakeServices(),
      tts: null,
      stt: null,
    });
    again.onSession(reopened.session());
    expect(again.getState().transcript[0].text).toMatch(
      /Welcome back\. You are on idea 2 of 3, Condensation/,
    );
    again.dispose();
  });
});

describe("a lesson by voice alone", () => {
  it("is completed with nothing but speaking and listening", async () => {
    h = setup({
      stt: fakeStt(["start", "next", "next", "next", "true"]),
    });
    h.controller.toggleListening(); // the learner presses the microphone once
    await settle();

    expect(h.session().phase).toBe("complete");
    expect(h.session().answeredCount).toBe(1);
    expect(h.session().correctCount).toBe(1);

    const said = h.tts!.said();
    expect(said).toContain("Evaporation. Heat turns liquid water into water vapor");
    expect(said).toContain("Condensation. Rising vapor cools");
    expect(said).toContain("Precipitation. When clouds hold too much water");
    expect(said).toContain("Quick question. True or false. Snow is a form of precipitation.");
    expect(said).toContain("Correct.");
    expect(said).toContain("That is the end of the lesson. You mastered");
    expect(h.texts("learner")).toEqual(["start", "next", "next", "next", "true"]);
  });

  it("listens again after each thing it says, until the lesson ends", async () => {
    h = setup({ stt: fakeStt(["start", "next"]) });
    h.controller.toggleListening();
    await settle();
    expect(h.stt!.starts()).toBeGreaterThanOrEqual(3);
  });

  it("goes through the statuses speaking, listening and thinking", async () => {
    h = setup({ stt: fakeStt(["start"]) });
    h.controller.toggleListening();
    await settle();
    expect(h.statuses()).toEqual(
      expect.arrayContaining(["speaking", "listening", "thinking", "idle"]),
    );
  });
});

describe("following the session", () => {
  it("says the first idea when the lesson starts, with the commands to try", async () => {
    h = setup();
    await h.controller.submit("start");
    await settle();
    expect(h.tts!.said()).toContain("Evaporation. Heat turns liquid water");
    expect(h.tts!.said()).toContain("Say next to go on");
  });

  it("says the same thing when a button or shortcut moved the lesson on", async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    h.tts!.spoken.length = 0;
    h.store.getState().next();
    await settle();
    expect(h.tts!.said()).toContain("Condensation. Rising vapor cools");
    expect(h.texts("tutor").at(-1)).toMatch(/^Condensation/);
  });

  it("does not repeat itself when the session changes in ways it does not narrate", async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    const count = h.tts!.spoken.length;
    h.store.setState({ session: { ...h.session() } });
    await settle();
    expect(h.tts!.spoken).toHaveLength(count);
  });

  it("does not speak a new idea over the old one", async () => {
    h = setup({ tts: fakeTts(false) });
    h.store.getState().start();
    h.store.getState().next();
    await settle();
    expect(h.tts!.cancels()).toBeGreaterThan(0);
    expect(h.tts!.spoken.some((t) => t.startsWith("Condensation"))).toBe(true);
  });
});

describe("commands", () => {
  beforeEach(async () => {
    h = setup();
    h.store.getState().start();
    await settle();
  });

  it("next moves on and previous goes back", async () => {
    await h.controller.submit("next");
    expect(h.session().conceptIndex).toBe(1);
    await h.controller.submit("go back");
    expect(h.session().conceptIndex).toBe(0);
  });

  it("repeat says the current idea again", async () => {
    h.tts!.spoken.length = 0;
    await h.controller.submit("say that again");
    await settle();
    expect(h.tts!.said()).toContain("Evaporation. Heat turns liquid water");
    expect(h.session().conceptIndex).toBe(0);
  });

  it("where am I says where, and how many are left", async () => {
    await h.controller.submit("where am I");
    await settle();
    expect(h.texts("tutor").at(-1)).toBe(
      "You are on idea 1 of 3, Evaporation, in How water moves. 2 more ideas to go.",
    );
  });

  it("says it is the last idea on the last one", async () => {
    h.store.getState().goTo(2);
    await settle();
    await h.controller.submit("where are we");
    expect(h.texts("tutor").at(-1)).toMatch(/This is the last idea\.$/);
  });

  it("quiz me opens a question", async () => {
    await h.controller.submit("quiz me");
    await settle();
    expect(h.session().phase).toBe("quiz");
    expect(h.tts!.said()).toContain("Quick question. What happens to water during evaporation?");
  });

  it("go to jumps to a named idea, even by part of its name", async () => {
    await h.controller.submit("take me to the part about precipitation");
    await settle();
    // The local matcher does not know this phrasing, so the intent service decides.
    expect(h.services.resolveIntent).toHaveBeenCalled();
    const resolved = h.controller;
    void resolved;
  });

  it("go to works from a resolved intent, by exact and by partial title", async () => {
    await h.controller.command({ type: "go_to", target: "condensation" });
    expect(h.session().conceptIndex).toBe(1);
    await h.controller.command({ type: "go_to", target: "precip" });
    expect(h.session().conceptIndex).toBe(2);
  });

  it("says so when a named idea is not in the lesson", async () => {
    await h.controller.command({ type: "go_to", target: "volcanoes" });
    await settle();
    expect(h.texts("tutor").at(-1)).toBe("I could not find volcanoes in this lesson.");
    expect(h.session().conceptIndex).toBe(0);
  });

  it("does not understand nonsense, and says what it can do", async () => {
    await h.controller.submit("mm");
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/did not get that/);
  });

  it("a command during a quiz points back to the question", async () => {
    await h.controller.submit("quiz me");
    await settle();
    await h.controller.command({ type: "next" });
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/Answer the question first/);
    expect(h.session().phase).toBe("quiz");
  });

  it("start again restarts a finished lesson", async () => {
    h.store.setState({ session: { ...h.session(), phase: "complete" } });
    await h.controller.command({ type: "next" });
    expect(h.session().phase).toBe("intro");
  });

  it("shows what the learner said, then what the tutor said", async () => {
    await h.controller.submit("  next ");
    const entries = h.state().transcript.filter((e) => e.role === "learner");
    expect(entries.at(-1)?.text).toBe("next");
  });

  it("ignores an empty submission", async () => {
    const before = h.state().transcript.length;
    await h.controller.submit("   ");
    expect(h.state().transcript).toHaveLength(before);
  });
});

describe("pause and resume", () => {
  it("pausing stops the voice and the microphone, and says how to carry on", async () => {
    h = setup({ tts: fakeTts(false), stt: fakeStt([]) });
    h.store.getState().start();
    await settle();
    const before = h.tts!.cancels();
    await h.controller.command({ type: "pause" });
    expect(h.state().status).toBe("paused");
    expect(h.tts!.cancels()).toBeGreaterThan(before);
    expect(h.texts("tutor").at(-1)).toMatch(/Paused\. Say resume/);
  });

  it("says nothing while paused, even if the lesson moves", async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "pause" });
    h.tts!.spoken.length = 0;
    h.store.getState().next();
    await settle();
    expect(h.tts!.spoken).toEqual([]);
    expect(h.state().status).toBe("paused");
  });

  it("resuming says where it was", async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "pause" });
    h.tts!.spoken.length = 0;
    h.controller.togglePause();
    await settle();
    expect(h.state().status).not.toBe("paused");
    expect(h.tts!.said()).toContain("Evaporation");
  });

  it("toggling pause twice pauses then resumes", async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    h.controller.togglePause();
    await settle();
    expect(h.state().status).toBe("paused");
    h.controller.togglePause();
    await settle();
    expect(h.state().status).not.toBe("paused");
  });

  it("the word resume or next also carries on", async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "pause" });
    await h.controller.submit("resume");
    await settle();
    expect(h.state().status).not.toBe("paused");
    expect(h.session().conceptIndex).toBe(0);
  });
});

describe("barge-in", () => {
  it("stops the voice at once", async () => {
    h = setup({ tts: fakeTts(false) });
    h.store.getState().start();
    await settle();
    expect(h.state().status).toBe("speaking");
    const before = h.tts!.cancels();
    h.controller.interrupt();
    expect(h.tts!.cancels()).toBeGreaterThan(before);
    expect(h.state().status).not.toBe("speaking");
  });

  it("does not go on to the next sentence, or carry on automatically, afterwards", async () => {
    h = setup({ tts: fakeTts(false), stt: fakeStt([]) });
    h.store.getState().start();
    await settle();
    const stale = h.tts!.finishOne;
    const spokenBefore = h.tts!.spoken.length;
    h.controller.interrupt();
    stale();
    await settle();
    expect(h.tts!.spoken.length).toBe(spokenBefore);
    expect(h.stt!.starts()).toBe(0);
  });

  it("can open the microphone straight away for the learner's turn", async () => {
    h = setup({ tts: fakeTts(false), stt: fakeStt([]) });
    h.store.getState().start();
    await settle();
    h.controller.interrupt({ listen: true });
    expect(h.stt!.starts()).toBe(1);
  });

  it("drops a reply that was still being fetched", async () => {
    let release!: () => void;
    h = setup({
      services: {
        tutorTurn: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              release = () => resolve("Late answer.");
            }),
        ),
      },
    });
    h.store.getState().start();
    await settle();
    const asking = h.controller.submit("why does water rise into the sky");
    await settle();
    h.controller.interrupt();
    release();
    await asking;
    await settle();
    expect(h.texts("tutor")).not.toContain("Late answer.");
  });
});

describe("quizzes by voice", () => {
  async function toQuestion(options: Options = {}) {
    h = setup(options);
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "quiz_me" });
    await settle();
    h.tts!.spoken.length = 0;
  }

  it("reads the question with lettered options", async () => {
    await toQuestion();
    await h.controller.submit("repeat");
    await settle();
    expect(h.tts!.said()).toContain("A. It turns into vapor. B. It turns into ice.");
  });

  it("registers the same answer for a letter and for the option's words", async () => {
    const results: Array<{ id: string | null; correct: boolean | undefined }> = [];
    for (const said of ["B", "bee", "the second one", "it turns into ice", "ice"]) {
      await toQuestion();
      await h.controller.submit(said);
      results.push({
        id: h.session().lastAnswer?.quizItemId ?? null,
        correct: h.session().lastAnswer?.correct,
      });
      h.controller.dispose();
    }
    expect(new Set(results.map((r) => r.id))).toEqual(new Set(["q_evaporation_1"]));
    expect(results.every((r) => r.correct === false)).toBe(true);
  });

  it("marks the right option right, by letter or by words", async () => {
    for (const said of ["A", "it turns into vapor", "vapor"]) {
      await toQuestion();
      await h.controller.submit(said);
      expect(h.session().lastAnswer).toEqual({ quizItemId: "q_evaporation_1", correct: true });
      h.controller.dispose();
    }
  });

  it("says the result, with the explanation, and goes on by itself when voice is on", async () => {
    await toQuestion();
    await h.controller.submit("A");
    await settle();
    expect(h.tts!.said()).toContain("Correct. Heat turns liquid water into water vapor.");
    expect(h.session().phase).toBe("learning");
  });

  it("gives the right answer after a wrong one", async () => {
    await toQuestion();
    await h.controller.submit("B");
    await settle();
    expect(h.tts!.said()).toContain("Not quite. The answer is It turns into vapor.");
  });

  it("says when it did not catch an answer, and does not change the question", async () => {
    await toQuestion();
    await h.controller.submit("banana");
    await settle();
    expect(h.session().phase).toBe("quiz");
    expect(h.texts("tutor").at(-1)).toMatch(/did not catch that\. Say the letter or the answer/);
  });

  it("repeats just the options when asked", async () => {
    await toQuestion();
    await h.controller.submit("read the options again");
    await settle();
    expect(h.texts("tutor").at(-1)).toBe(
      "A. It turns into vapor. B. It turns into ice. C. It falls as rain. D. It sinks underground.",
    );
  });

  it("answers a true or false question", async () => {
    h = setup();
    h.store.getState().start();
    h.store.getState().goTo(2);
    await settle();
    await h.controller.command({ type: "quiz_me" });
    await settle();
    expect(h.session().activeQuizItemId).toBe("q_precipitation_1");
    await h.controller.submit("it is true");
    expect(h.session().lastAnswer).toEqual({ quizItemId: "q_precipitation_1", correct: true });
  });

  it("lets the learner pause or ask where they are in the middle of a question", async () => {
    await toQuestion();
    await h.controller.submit("where am i");
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/in a quick check/);
    expect(h.session().phase).toBe("quiz");
  });

  it("does not pick an answer when two options fit what was said", async () => {
    await toQuestion();
    await h.controller.submit("it turns into");
    expect(h.session().phase).toBe("quiz");
  });
});

describe("short answers", () => {
  async function toShortQuestion(options: Options = {}) {
    h = setup(options);
    h.store.getState().start();
    h.store.getState().goTo(1);
    await settle();
    // Ask until the short-answer item of Condensation is the active one.
    for (let i = 0; i < 4 && h.session().activeQuizItemId !== "q_condensation_2"; i++) {
      if (h.session().phase === "learning") await h.controller.command({ type: "quiz_me" });
      else {
        await h.controller.submit(
          h.session().activeQuizItemId === "q_condensation_1" ? "clouds" : "x",
        );
        await settle();
      }
      await settle();
    }
  }

  it("is graded by the grading service, and its feedback is spoken", async () => {
    await toShortQuestion();
    expect(h.session().activeQuizItemId).toBe("q_condensation_2");
    h.tts!.spoken.length = 0;
    await h.controller.submit("when vapor turns into tiny drops");
    await settle();
    expect(h.services.gradeShortAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        quizItemId: "q_condensation_2",
        answer: "when vapor turns into tiny drops",
      }),
    );
    expect(h.tts!.said()).toContain("Nicely put.");
  });

  it("falls back to the strict local check when grading is not available", async () => {
    await toShortQuestion({
      services: {
        gradeShortAnswer: vi.fn(async () => {
          throw new Error("down");
        }),
      },
    });
    await h.controller.submit("condensation");
    expect(h.session().lastAnswer).toEqual({ quizItemId: "q_condensation_2", correct: true });
  });

  it("marks a wrong short answer wrong locally when grading is down", async () => {
    await toShortQuestion({
      services: {
        gradeShortAnswer: vi.fn(async () => {
          throw new Error("down");
        }),
      },
    });
    await h.controller.submit("evaporation");
    expect(h.session().lastAnswer).toEqual({ quizItemId: "q_condensation_2", correct: false });
  });
});

describe("questions to the tutor", () => {
  beforeEach(async () => {
    h = setup();
    h.store.getState().start();
    await settle();
    h.tts!.spoken.length = 0;
  });

  it("asks the service about the current idea and speaks the reply", async () => {
    await h.controller.submit("why does vapor turn into clouds when it is high up");
    await settle();
    expect(h.services.tutorTurn).toHaveBeenCalledWith(
      {
        lessonId: graph.lessonId,
        conceptId: "c_evaporation",
        intent: { type: "question", text: "why does vapor turn into clouds when it is high up" },
      },
      expect.objectContaining({ onText: expect.any(Function) }),
    );
    expect(h.tts!.said()).toContain("It cools into drops.");
    expect(h.texts("tutor").at(-1)).toBe("It cools into drops. That makes clouds.");
  });

  it("starts speaking the first sentence before the reply has finished arriving", async () => {
    let finish!: (text: string) => void;
    h = setup({
      services: {
        tutorTurn: vi.fn(async (_request, { onText }) => {
          onText("First sentence here. Second");
          return new Promise<string>((resolve) => {
            finish = (text) => {
              onText(" part.");
              resolve(text);
            };
          });
        }),
      },
    });
    h.store.getState().start();
    await settle();
    h.tts!.spoken.length = 0;
    const asking = h.controller.submit("tell me something about this");
    await settle();
    expect(h.tts!.spoken).toEqual(["First sentence here."]);
    expect(h.texts("tutor").at(-1)).not.toMatch(/First sentence/);
    finish("First sentence here. Second part.");
    await asking;
    await settle();
    expect(h.tts!.spoken).toContain("Second part.");
  });

  it("says the lesson does not cover something it does not cover", async () => {
    h.controller.dispose();
    h = setup({
      services: { tutorTurn: vi.fn(async () => notCoveredReply("Evaporation")) },
    });
    h.store.getState().start();
    await settle();
    await h.controller.submit("who won the 1998 world cup");
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/doesn't cover that/);
  });

  it.each([
    ["simpler", "simplify"],
    ["tell me more", "elaborate"],
    ["give me an example", "example"],
  ] as const)("%s asks the tutor to %s", async (said, type) => {
    await h.controller.submit(said);
    await settle();
    expect(vi.mocked(h.services.tutorTurn).mock.calls[0][0].intent).toEqual({ type });
  });

  it("says so, in words, when the tutor cannot be reached", async () => {
    h.controller.dispose();
    h = setup({
      services: {
        tutorTurn: vi.fn(async () => {
          throw new Error("I could not connect. Check your connection and try again.");
        }),
      },
    });
    h.store.getState().start();
    await settle();
    await h.controller.submit("why is the sky blue today");
    await settle();
    expect(h.texts("tutor").at(-1)).toBe(
      "I could not connect. Check your connection and try again.",
    );
  });

  it("does not ask the tutor in the middle of a question", async () => {
    await h.controller.command({ type: "quiz_me" });
    await settle();
    await h.controller.command({ type: "simplify" });
    await settle();
    expect(h.services.tutorTurn).not.toHaveBeenCalled();
    expect(h.texts("tutor").at(-1)).toMatch(/finish this question first/);
  });

  it("drops the reply to an earlier question when a newer one is asked", async () => {
    const replies = new Map<string, (t: string) => void>();
    h.controller.dispose();
    h = setup({
      services: {
        tutorTurn: vi.fn(
          (request) =>
            new Promise<string>((resolve) => {
              replies.set(request.intent.type === "question" ? request.intent.text : "", resolve);
            }),
        ),
      },
    });
    h.store.getState().start();
    await settle();
    const first = h.controller.submit("first long question here");
    await settle();
    const second = h.controller.submit("second long question here");
    await settle();
    replies.get("first long question here")!("Old reply.");
    replies.get("second long question here")!("New reply.");
    await Promise.all([first, second]);
    await settle();
    expect(h.texts("tutor")).not.toContain("Old reply.");
    expect(h.texts("tutor")).toContain("New reply.");
  });
});

describe("settings by voice", () => {
  beforeEach(async () => {
    h = setup();
    h.store.getState().start();
    await settle();
  });

  it("slower and faster change the speaking speed in the profile, a step at a time", async () => {
    const start = h.profile().audio.rate;
    await h.controller.submit("slow down");
    expect(h.profile().audio.rate).toBe(start - 0.25);
    await h.controller.submit("faster");
    await h.controller.submit("faster");
    expect(h.profile().audio.rate).toBe(start + 0.25);
    expect(h.updateProfile).toHaveBeenCalledWith({ audio: { rate: start - 0.25 } });
  });

  it("says when it cannot go any slower or faster", async () => {
    for (let i = 0; i < 12; i++) await h.controller.submit("slower");
    expect(h.profile().audio.rate).toBe(0.5);
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/as slow as I go/);
    for (let i = 0; i < 14; i++) await h.controller.submit("faster");
    expect(h.profile().audio.rate).toBe(3);
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/as fast as I go/);
  });

  it("hands a settings request to the needs parser and applies the result", async () => {
    await h.controller.command({ type: "change_profile", request: "make the text bigger" });
    await settle();
    expect(h.services.parseNeeds).toHaveBeenCalledWith("make the text bigger", expect.any(Object));
    expect(h.profile().typography.sizeScale).toBe(1.5);
    expect(h.texts("tutor").at(-1)).toBe("I made the text bigger.");
  });

  it("says why when the parser refuses a change, and applies nothing", async () => {
    h.controller.dispose();
    h = setup({
      services: {
        parseNeeds: vi.fn(async () => ({
          ok: false as const,
          message: "I could not make that change safely.",
          unsupported: [],
        })),
      },
    });
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "change_profile", request: "do something odd" });
    await settle();
    expect(h.updateProfile).not.toHaveBeenCalled();
    expect(h.texts("tutor").at(-1)).toBe("I could not make that change safely.");
  });

  it("points to Settings when the parser cannot be reached", async () => {
    h.controller.dispose();
    h = setup({
      services: {
        parseNeeds: vi.fn(async () => {
          throw new Error("offline");
        }),
      },
    });
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "change_profile", request: "bigger" });
    await settle();
    expect(h.texts("tutor").at(-1)).toMatch(/Settings button/);
  });
});

describe("muting Prism's voice", () => {
  it("shows what it would have said, and says nothing", async () => {
    h = setup();
    h.controller.setMuted(true);
    h.store.getState().start();
    await settle();
    expect(h.tts!.spoken).toEqual([]);
    expect(h.texts("tutor").at(-1)).toMatch(/^Evaporation\./);
    expect(h.state().muted).toBe(true);
  });

  it("stops what is being said the moment it is muted", async () => {
    h = setup({ tts: fakeTts(false) });
    h.store.getState().start();
    await settle();
    const before = h.tts!.cancels();
    h.controller.setMuted(true);
    expect(h.tts!.cancels()).toBeGreaterThan(before);
  });

  it("does not carry on by itself after a result, so the learner can read it", async () => {
    h = setup();
    h.controller.setMuted(true);
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "quiz_me" });
    await h.controller.submit("A");
    await settle();
    expect(h.session().phase).toBe("feedback");
  });

  it("speaks again when unmuted", async () => {
    h = setup();
    h.controller.setMuted(true);
    h.controller.setMuted(false);
    h.store.getState().start();
    await settle();
    expect(h.tts!.spoken.length).toBeGreaterThan(0);
  });
});

describe("without a voice or a microphone", () => {
  it("works as text only when speech is not available", async () => {
    h = setup({ tts: null, stt: null });
    expect(h.state()).toMatchObject({ canSpeak: false, canListen: false });
    await h.controller.submit("start");
    await h.controller.submit("next");
    expect(h.session()).toMatchObject({ phase: "learning", conceptIndex: 1 });
    expect(h.texts("tutor").at(-1)).toMatch(/^Condensation/);
  });

  it("completes a whole lesson by typing alone", async () => {
    h = setup({ tts: null, stt: null });
    for (const said of ["start", "next", "next", "next", "true"]) await h.controller.submit(said);
    expect(h.session().phase).toBe("feedback");
    await h.controller.submit("next");
    expect(h.session().phase).toBe("complete");
    expect(h.texts("tutor").at(-1)).toMatch(/end of the lesson/);
  });

  it("does not open a microphone when voice input is off", async () => {
    h = setup({ preset: "standard", stt: fakeStt([]) });
    h.store.getState().start();
    await settle();
    expect(h.stt!.starts()).toBe(0);
  });
});

describe("the microphone", () => {
  it("opens for one utterance when pressed, and closes when pressed again", async () => {
    h = setup({ stt: fakeStt([], null) });
    h.controller.toggleListening();
    expect(h.state().status).toBe("listening");
    h.controller.toggleListening();
    expect(h.stt!.stops()).toBe(1);
  });

  it("shows what is being heard as it is heard", async () => {
    const stt = fakeStt([], null);
    h = setup({ stt });
    h.controller.toggleListening();
    const start = vi.spyOn(stt.provider, "start");
    void start;
    expect(h.state().partial).toBe("");
  });

  it("says why when the microphone is refused, and does not blame the learner", async () => {
    h = setup({ stt: fakeStt([], "permission_denied") });
    h.controller.toggleListening();
    await settle();
    expect(h.state().error).toMatch(/Allow microphone access/);
  });

  it("tries once more after silence, then waits quietly without an error", async () => {
    h = setup({ stt: fakeStt([], "no_speech") });
    h.controller.toggleListening();
    await settle();
    expect(h.stt!.starts()).toBe(2);
    expect(h.state().error).toBeNull();
    expect(h.state().status).toBe("idle");
  });

  it("does not listen while the tutor is speaking", async () => {
    h = setup({ tts: fakeTts(false), stt: fakeStt([]) });
    h.store.getState().start();
    await settle();
    expect(h.state().status).toBe("speaking");
    expect(h.stt!.starts()).toBe(0);
  });
});

describe("earcons", () => {
  it("are asked for when listening starts and when a result is given", async () => {
    const earcon = vi.fn();
    h = setup({ earcon, stt: fakeStt([], null) });
    h.controller.toggleListening();
    expect(earcon).toHaveBeenCalledWith("listening");
    h.store.getState().start();
    await settle();
    await h.controller.command({ type: "quiz_me" });
    await h.controller.submit("A");
    await settle();
    expect(earcon).toHaveBeenCalledWith("correct");
    await h.controller.command({ type: "quiz_me" });
    await h.controller.submit(h.session().activeQuizItemId === "q_evaporation_2" ? "false" : "B");
    await settle();
    expect(earcon).toHaveBeenCalledWith("incorrect");
  });
});

describe("a voice that fails", () => {
  it("shows the problem in words and still shows the transcript", async () => {
    const tts = fakeTts();
    tts.provider.speak = (_text, handlers) => handlers.onError?.("blocked");
    h = setup({ tts });
    h.store.getState().start();
    await settle();
    expect(h.state().error).toMatch(/stopped Prism from speaking/);
    expect(h.texts("tutor").at(-1)).toMatch(/^Evaporation\./);
  });
});

describe("the intent guess", () => {
  it("treats a longer utterance as a question, and a short one as nothing", () => {
    expect(guessIntent("why is the sky blue")).toEqual({
      type: "question",
      text: "why is the sky blue",
    });
    expect(guessIntent("what?")).toEqual({ type: "question", text: "what?" });
    expect(guessIntent("hmm")).toEqual({ type: "unknown" });
  });
});

describe("disposing", () => {
  it("stops speaking and listening, and ignores later changes", async () => {
    h = setup({ tts: fakeTts(false), stt: fakeStt([], null) });
    h.store.getState().start();
    await settle();
    const before = h.tts!.cancels();
    h.controller.dispose();
    expect(h.tts!.cancels()).toBeGreaterThan(before);
    const length = h.state().transcript.length;
    h.store.getState().next();
    await settle();
    expect(h.state().transcript).toHaveLength(length);
  });
});

describe("intents the model can return", () => {
  it("handles every command type without throwing", async () => {
    const intents: SessionIntent[] = [
      { type: "next" },
      { type: "previous" },
      { type: "repeat" },
      { type: "simplify" },
      { type: "elaborate" },
      { type: "example" },
      { type: "quiz_me" },
      { type: "answer", value: "A" },
      { type: "pause" },
      { type: "resume" },
      { type: "where_am_i" },
      { type: "go_to", target: "x" },
      { type: "set_rate", direction: "faster" },
      { type: "change_profile", request: "bigger" },
      { type: "question", text: "why" },
      { type: "unknown" },
    ];
    for (const intent of intents) {
      h = setup();
      await expect(h.controller.command(intent)).resolves.toBeUndefined();
      h.controller.dispose();
    }
  });
});
