import { describe, expect, it } from "vitest";
import {
  buildContext,
  createSessionStore,
  restoreSession,
  SESSION_STORAGE_PREFIX,
  type QuizSettings,
  type StorageLike,
} from "@/lib/session/store";
import { createSession } from "@/lib/session/machine";
import { makeGraph } from "../fixtures/graph";

const memory = (
  initial: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
};

const settings = (overrides: Partial<QuizSettings> = {}): QuizSettings => ({
  cadence: 2,
  itemsPerCheck: 1,
  retryOnWrong: true,
  ...overrides,
});

function make(
  options: {
    storage?: StorageLike | null;
    settings?: () => QuizSettings;
    graphVersion?: number;
  } = {},
) {
  const graph = makeGraph();
  return createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: options.graphVersion ?? 1,
    graph,
    getSettings: options.settings ?? (() => settings()),
    storage: options.storage === undefined ? memory() : options.storage,
    now: () => 5000,
  });
}

describe("buildContext", () => {
  it("lists concepts in teaching order with their quiz items", () => {
    const graph = makeGraph();
    [graph.concepts[0], graph.concepts[2]] = [graph.concepts[2], graph.concepts[0]];
    graph.concepts[0].order = 0;
    graph.concepts[2].order = 2;
    const ctx = buildContext(graph, settings());
    expect(ctx.conceptIds).toEqual(["c_precipitation", "c_condensation", "c_evaporation"]);
    expect(ctx.quizItemsByConcept.c_evaporation).toEqual(["q_evaporation_1", "q_evaporation_2"]);
    expect(ctx).toMatchObject({ cadence: 2, itemsPerCheck: 1, retryOnWrong: true });
  });

  it("ignores quiz items for concepts that are not in the lesson", () => {
    const graph = makeGraph();
    graph.quizItems.push({ ...graph.quizItems[0], id: "q_orphan", conceptId: "c_gone" });
    const all = Object.values(buildContext(graph, settings()).quizItemsByConcept).flat();
    expect(all).not.toContain("q_orphan");
  });
});

describe("session store actions", () => {
  it("starts in the intro and begins on the first concept", () => {
    const store = make();
    expect(store.getState().session.phase).toBe("intro");
    store.getState().start();
    expect(store.getState().session).toMatchObject({
      phase: "learning",
      conceptIndex: 0,
      startedAt: 5000,
    });
  });

  it("walks through learning, a quiz, feedback and onwards", () => {
    const store = make();
    const s = store.getState();
    s.start();
    s.next();
    s.next(); // cadence 2: a quiz after the second concept
    expect(store.getState().session.phase).toBe("quiz");
    const item = store.getState().session.activeQuizItemId as string;
    s.answer(item, true);
    expect(store.getState().session.phase).toBe("feedback");
    s.continue();
    expect(store.getState().session).toMatchObject({ phase: "learning", conceptIndex: 2 });
  });

  it("supports previous, goTo, requestQuiz and restart", () => {
    const store = make();
    const s = store.getState();
    s.start();
    s.next();
    s.previous();
    expect(store.getState().session.conceptIndex).toBe(0);
    s.goTo(2);
    expect(store.getState().session.conceptIndex).toBe(2);
    s.requestQuiz();
    expect(store.getState().session.phase).toBe("quiz");
    s.restart();
    expect(store.getState().session).toMatchObject({ phase: "intro", seenConceptIds: [] });
  });

  it("does not create a new state object for an action that changes nothing", () => {
    const store = make();
    const before = store.getState().session;
    store.getState().next(); // ignored in the intro
    expect(store.getState().session).toBe(before);
  });

  it("reads the quiz settings fresh each time, so a profile change takes effect at once", () => {
    let current = settings({ cadence: 5 });
    const store = make({ settings: () => current });
    store.getState().start();
    store.getState().next();
    expect(store.getState().session.phase).toBe("learning"); // cadence 5: no quiz yet
    current = settings({ cadence: 2 });
    store.getState().next();
    expect(store.getState().session.phase).toBe("quiz"); // now due
  });

  it("keeps the place when settings change mid lesson", () => {
    let current = settings();
    const store = make({ settings: () => current });
    store.getState().start();
    store.getState().next();
    const before = store.getState().session;
    current = settings({ cadence: 9, itemsPerCheck: 3 });
    expect(store.getState().session).toBe(before);
  });
});

describe("session persistence", () => {
  it("restores the same concept and phase after a reload", () => {
    const storage = memory();
    const first = make({ storage });
    first.getState().hydrate();
    first.getState().start();
    first.getState().next(); // on concept 2, learning

    const reloaded = make({ storage });
    reloaded.getState().hydrate();
    expect(reloaded.getState().session).toMatchObject({ phase: "learning", conceptIndex: 1 });
    expect(reloaded.getState().session.seenConceptIds).toEqual(["c_evaporation", "c_condensation"]);
  });

  it("restores a lesson that was left in the middle of a quiz", () => {
    const storage = memory();
    const first = make({ storage });
    first.getState().start();
    first.getState().next();
    first.getState().next();
    const item = first.getState().session.activeQuizItemId;

    const reloaded = make({ storage });
    reloaded.getState().hydrate();
    expect(reloaded.getState().session).toMatchObject({ phase: "quiz", activeQuizItemId: item });
  });

  it("restores feedback and carries on correctly", () => {
    const storage = memory();
    const first = make({ storage });
    first.getState().start();
    first.getState().next();
    first.getState().next();
    first.getState().answer(first.getState().session.activeQuizItemId as string, true);

    const reloaded = make({ storage });
    reloaded.getState().hydrate();
    expect(reloaded.getState().session.phase).toBe("feedback");
    reloaded.getState().continue();
    expect(reloaded.getState().session).toMatchObject({ phase: "learning", conceptIndex: 2 });
  });

  it("keeps each lesson's place separate", () => {
    const storage = memory();
    const a = createSessionStore({
      lessonId: "lesson_a",
      graphVersion: 1,
      graph: { ...makeGraph(), concepts: makeGraph().concepts },
      getSettings: () => settings(),
      storage,
    });
    a.getState().start();
    expect([...storage.data.keys()]).toEqual([`${SESSION_STORAGE_PREFIX}lesson_a`]);
  });

  it("does not load before hydrate, so server and first client render match", () => {
    const storage = memory();
    const first = make({ storage });
    first.getState().start();
    const reloaded = make({ storage });
    expect(reloaded.getState().session.phase).toBe("intro");
    expect(reloaded.getState().hydrated).toBe(false);
  });

  it.each([
    ["not json", "{nope"],
    ["the wrong shape", JSON.stringify({ phase: "learning" })],
    [
      "a different lesson",
      JSON.stringify({ ...createSession({ lessonId: "other", graphVersion: 1 }) }),
    ],
    [
      "an impossible position",
      JSON.stringify({
        ...createSession({ lessonId: makeGraph().lessonId, graphVersion: 1 }),
        phase: "learning",
        conceptIndex: 99,
      }),
    ],
  ])("starts fresh when the saved data is %s", (_name, stored) => {
    const store = make({
      storage: memory({ [`${SESSION_STORAGE_PREFIX}${makeGraph().lessonId}`]: stored }),
    });
    store.getState().hydrate();
    expect(store.getState().session.phase).toBe("intro");
  });

  it("works without storage, and when storage throws", () => {
    const none = make({ storage: null });
    none.getState().hydrate();
    none.getState().start();
    expect(none.getState().session.phase).toBe("learning");

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = make({ storage: throwing });
    store.getState().hydrate();
    store.getState().start();
    expect(store.getState().session.phase).toBe("learning");
  });
});

describe("restoreSession: a lesson that changed since the session was saved", () => {
  const graph = makeGraph();
  const ctx = buildContext(graph, settings());
  const fresh = createSession({ lessonId: graph.lessonId, graphVersion: 2, now: 1 });
  const saved = {
    ...fresh,
    graphVersion: 1,
    phase: "learning",
    conceptIndex: 1,
    seenConceptIds: ["c_evaporation", "c_condensation", "c_deleted"],
    sinceQuizConceptIds: ["c_condensation", "c_deleted"],
    conceptsSinceQuiz: 2,
  };

  it("keeps the place and drops concepts that no longer exist", () => {
    const restored = restoreSession(saved, fresh, ctx);
    expect(restored).toMatchObject({ phase: "learning", conceptIndex: 1, graphVersion: 2 });
    expect(restored.seenConceptIds).toEqual(["c_evaporation", "c_condensation"]);
    expect(restored.conceptsSinceQuiz).toBe(1);
  });

  it("falls back to reading when the question it was asking is gone", () => {
    const restored = restoreSession(
      {
        ...saved,
        phase: "quiz",
        activeQuizItemId: "q_deleted",
        quizQueue: ["q_deleted", "q_evaporation_1"],
      },
      fresh,
      ctx,
    );
    expect(restored).toMatchObject({ phase: "learning", activeQuizItemId: null, quizQueue: [] });
  });

  it("keeps a quiz in progress when its question still exists", () => {
    const restored = restoreSession(
      { ...saved, phase: "quiz", activeQuizItemId: "q_evaporation_1" },
      fresh,
      ctx,
    );
    expect(restored).toMatchObject({ phase: "quiz", activeQuizItemId: "q_evaporation_1" });
  });

  it("falls back from feedback with no recorded answer", () => {
    expect(
      restoreSession({ ...saved, phase: "feedback", lastAnswer: null }, fresh, ctx).phase,
    ).toBe("learning");
  });
});
