// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createProfileStore } from "@/lib/profile/store";
import { createSession, type LessonSession } from "@/lib/session/machine";
import type { TrackInput } from "@/lib/session/events";
import { createSessionStore } from "@/lib/session/store";
import { deriveEvents, trackProfileChanges, type EventContext } from "@/lib/session/telemetry";
import { PrismRenderer } from "@/renderers/PrismRenderer";
import { makeGraph } from "../fixtures/graph";

const graph = makeGraph();

function makeStore(onEvent: (e: TrackInput) => void, clock = { t: 0 }) {
  return createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 3,
    graph,
    getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
    storage: null,
    now: () => clock.t,
    onEvent,
  });
}

const types = (events: TrackInput[]) => events.map((e) => e.type);
const count = (events: TrackInput[]) =>
  events.reduce<Record<string, number>>(
    (acc, e) => ({ ...acc, [e.type]: (acc[e.type] ?? 0) + 1 }),
    {},
  );

describe("events from the session store", () => {
  it("reports the lesson starting, the first idea being left, and each next idea", () => {
    const events: TrackInput[] = [];
    const clock = { t: 0 };
    const store = makeStore((e) => events.push(e), clock);
    store.getState().start();
    expect(types(events)).toEqual(["lesson_started"]);
    clock.t = 20_000;
    store.getState().next();
    expect(events.slice(1)).toEqual([
      expect.objectContaining({
        type: "concept_viewed",
        conceptId: "c_evaporation",
        durationMs: 20_000,
        lessonId: graph.lessonId,
        graphVersion: 3,
      }),
    ]);
  });

  it("gives the time on each idea, counting only active time", () => {
    const events: TrackInput[] = [];
    const clock = { t: 0 };
    const store = makeStore((e) => events.push(e), clock);
    store.getState().start();
    clock.t = 10_000;
    store.getState().next();
    clock.t = 10_000 + 30 * 60_000; // a long walk away
    store.getState().next();
    const viewed = events.filter((e) => e.type === "concept_viewed");
    expect(viewed.map((e) => [e.conceptId, e.durationMs])).toEqual([
      ["c_evaporation", 10_000],
      ["c_condensation", 60_000],
    ]);
  });

  it("reports a question being asked and answered, with its idea, whether it was right, and the time taken", () => {
    const events: TrackInput[] = [];
    const clock = { t: 0 };
    const store = makeStore((e) => events.push(e), clock);
    store.getState().start();
    clock.t = 5_000;
    store.getState().requestQuiz();
    const presented = events.at(-1)!;
    expect(presented).toMatchObject({
      type: "quiz_presented",
      quizItemId: "q_evaporation_1",
      conceptId: "c_evaporation",
    });
    clock.t = 12_000;
    store.getState().answer("q_evaporation_1", true);
    expect(events.at(-1)).toMatchObject({
      type: "quiz_answered",
      quizItemId: "q_evaporation_1",
      conceptId: "c_evaporation",
      correct: true,
      durationMs: 7_000,
    });
  });

  it("closes the idea being read when a question appears, and opens a new view on coming back", () => {
    const events: TrackInput[] = [];
    const store = makeStore((e) => events.push(e));
    store.getState().start();
    store.getState().requestQuiz();
    store.getState().answer("q_evaporation_1", true);
    store.getState().continue(); // back to reading the same idea
    store.getState().next();
    expect(count(events)).toMatchObject({ concept_viewed: 2, quiz_presented: 1, quiz_answered: 1 });
  });

  it("reports the end, with the total time", () => {
    const events: TrackInput[] = [];
    const clock = { t: 0 };
    const store = makeStore((e) => events.push(e), clock);
    store.getState().start();
    for (let i = 0; i < 3; i++) {
      clock.t += 4_000;
      store.getState().next();
    }
    clock.t += 4_000;
    store.getState().answer(store.getState().session.activeQuizItemId!, true);
    clock.t += 4_000;
    store.getState().continue();
    expect(events.at(-1)).toMatchObject({ type: "lesson_completed", durationMs: 20_000 });
    expect(count(events)).toEqual({
      lesson_started: 1,
      concept_viewed: 3,
      quiz_presented: 1,
      quiz_answered: 1,
      lesson_completed: 1,
    });
  });

  it("starts the story again after a restart, closing the idea that was open", () => {
    const events: TrackInput[] = [];
    const clock = { t: 0 };
    const store = makeStore((e) => events.push(e), clock);
    store.getState().start();
    clock.t = 15_000;
    store.getState().restart();
    expect(events.at(-1)).toMatchObject({
      type: "concept_viewed",
      conceptId: "c_evaporation",
      durationMs: 15_000,
    });
    store.getState().start();
    expect(count(events).lesson_started).toBe(2);
  });

  it("reports nothing for an action that changes nothing", () => {
    const events: TrackInput[] = [];
    const store = makeStore((e) => events.push(e));
    store.getState().next(); // not started
    store.getState().previous();
    store.getState().continue();
    expect(events).toEqual([]);
  });

  it("reports nothing when no listener is given", () => {
    const store = createSessionStore({
      lessonId: graph.lessonId,
      graphVersion: 1,
      graph,
      getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
      storage: null,
    });
    expect(() => {
      store.getState().start();
      store.getState().next();
    }).not.toThrow();
  });

  it("does not report the idea a returning learner was on, until they leave it", () => {
    const events: TrackInput[] = [];
    const saved = new Map<string, string>();
    const storage = {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
    };
    const make = (onEvent: (e: TrackInput) => void) =>
      createSessionStore({
        lessonId: graph.lessonId,
        graphVersion: 3,
        graph,
        getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
        storage,
        now: () => 0,
        onEvent,
      });
    const first = make(() => {});
    first.getState().start();
    first.getState().next();
    const second = make((e) => events.push(e));
    second.getState().hydrate();
    expect(events).toEqual([]);
    second.getState().next();
    expect(events).toEqual([
      expect.objectContaining({ type: "concept_viewed", conceptId: "c_condensation" }),
    ]);
  });
});

describe("deriveEvents on its own", () => {
  const ctx: EventContext = {
    conceptIds: ["a", "b"],
    conceptOfItem: (id) => (id === "qa" ? "a" : undefined),
  };
  const base = createSession({ lessonId: "l", graphVersion: 1 });
  const learning = (over: Partial<LessonSession> = {}): LessonSession => ({
    ...base,
    phase: "learning",
    conceptIndex: 0,
    ...over,
  });

  it("opens a view on arriving and keeps it open while on the same idea", () => {
    const first = deriveEvents(base, learning(), null, ctx);
    expect(types(first.events)).toEqual(["lesson_started"]);
    expect(first.view).toEqual({ conceptId: "a", activeAtStart: 0 });
    const again = deriveEvents(learning(), learning({ activeMs: 5 }), first.view, ctx);
    expect(again.events).toEqual([]);
    expect(again.view).toBe(first.view);
  });

  it("never reports a negative time", () => {
    const result = deriveEvents(
      learning({ activeMs: 50 }),
      learning({ conceptIndex: 1, activeMs: 10 }),
      { conceptId: "a", activeAtStart: 50 },
      ctx,
    );
    expect(result.events[0].durationMs).toBe(0);
  });

  it("leaves the idea unnamed for a question it cannot place", () => {
    const quiz = { ...base, phase: "quiz" as const, activeQuizItemId: "qz" };
    const out = deriveEvents(learning(), quiz, { conceptId: "a", activeAtStart: 0 }, ctx);
    expect(out.events.find((e) => e.type === "quiz_presented")).toMatchObject({
      quizItemId: "qz",
      conceptId: undefined,
    });
  });

  it("carries the lesson and version on every event", () => {
    const out = deriveEvents(base, learning(), null, { ...ctx });
    for (const event of out.events) expect(event).toMatchObject({ lessonId: "l", graphVersion: 1 });
  });
});

describe("profile changes", () => {
  it("reports each change to the settings, but not loading them", () => {
    const events: TrackInput[] = [];
    const profileStore = createProfileStore({ storage: null });
    const stop = trackProfileChanges(profileStore, {
      lessonId: "l",
      graphVersion: 2,
      track: (e) => events.push(e),
    });
    profileStore.getState().hydrate();
    expect(events).toEqual([]);
    profileStore.getState().applyPatch({ typography: { sizeScale: 1.5 } });
    profileStore.getState().applyPreset("hyper_focus");
    expect(events).toEqual([
      { type: "profile_changed", lessonId: "l", graphVersion: 2 },
      { type: "profile_changed", lessonId: "l", graphVersion: 2 },
    ]);
    stop();
    profileStore.getState().applyPatch({ typography: { sizeScale: 2 } });
    expect(events).toHaveLength(2);
  });

  it("does not say what was changed, only that something was", () => {
    const events: TrackInput[] = [];
    const profileStore = createProfileStore({ storage: null });
    profileStore.getState().hydrate();
    trackProfileChanges(profileStore, {
      lessonId: "l",
      graphVersion: 1,
      track: (e) => events.push(e),
    });
    profileStore.getState().applyPatch({ audio: { readAloud: true } });
    expect(Object.keys(events[0]).sort()).toEqual(["graphVersion", "lessonId", "type"]);
  });
});

describe("the same events in every layout (CE-10)", () => {
  async function completeLesson(
    preset: "hyper_focus" | "standard" | "voice_native" | "visual_sign",
  ) {
    const events: TrackInput[] = [];
    const profileStore = createProfileStore({ storage: null });
    profileStore.getState().applyPreset(preset);
    profileStore.getState().applyPatch({
      content: { readingLevel: "original", chunkSize: "concept" },
      quiz: { cadence: 5, itemsPerCheck: 1 },
      audio: { readAloud: false, voiceInput: false },
    });
    const sessionStore = makeStore((e) => events.push(e));
    const user = userEvent.setup();
    const { unmount } = render(
      <PrismRenderer graph={graph} sessionStore={sessionStore} profileStore={profileStore} />,
    );
    const session = () => sessionStore.getState().session;
    const press = async (name: string | RegExp) =>
      user.click(await screen.findByRole("button", { name }));
    const layout = profileStore.getState().profile.layout;

    await press("Start");
    if (layout === "conversation") {
      for (const said of ["next", "next", "next"])
        await user.type(
          await screen.findByLabelText("Type what you want to say"),
          `${said}{Enter}`,
        );
    } else {
      for (let i = 0; i < 3; i++)
        await press(layout === "reader" ? (i === 2 ? "Finish" : "Next idea") : "Next");
    }
    await waitFor(() => expect(session().phase).toBe("quiz"));
    const item = graph.quizItems.find((q) => q.id === session().activeQuizItemId)!;
    if (layout === "conversation") {
      await user.type(
        await screen.findByLabelText("Type what you want to say"),
        `${item.answer}{Enter}`,
      );
    } else {
      await press(item.type === "true_false" ? "True" : item.answer);
    }
    await waitFor(() => expect(session().phase).toBe("feedback"));
    if (layout === "conversation") {
      await user.type(await screen.findByLabelText("Type what you want to say"), "next{Enter}");
    } else {
      await press("Continue");
    }
    await waitFor(() => expect(session().phase).toBe("complete"));
    unmount();
    return { layout, events };
  }

  it("completing the lesson gives the same event types and counts in cards, reader, conversation and visual", async () => {
    const results = [];
    for (const preset of ["hyper_focus", "standard", "voice_native", "visual_sign"] as const) {
      results.push(await completeLesson(preset));
    }
    expect(results.map((r) => r.layout)).toEqual(["cards", "reader", "conversation", "visual"]);
    const expected = {
      lesson_started: 1,
      concept_viewed: 3,
      quiz_presented: 1,
      quiz_answered: 1,
      lesson_completed: 1,
    };
    for (const { layout, events } of results) {
      expect(count(events), layout).toEqual(expected);
      expect(types(events), layout).toEqual(types(results[0].events));
    }
    act(() => {});
  });
});
