import { describe, expect, it } from "vitest";
import {
  createSession,
  masteredConceptIds,
  type LessonSession,
  reduceSession,
  type SessionAction,
  type SessionContext,
} from "@/lib/session/machine";
import {
  createSessionStore,
  MAX_ACTIVE_GAP_MS,
  restoreSession,
  SESSION_STORAGE_PREFIX,
  type StorageLike,
} from "@/lib/session/store";
import { makeGraph } from "../fixtures/graph";

const ctx: SessionContext = {
  conceptIds: ["c1", "c2", "c3"],
  quizItemsByConcept: { c1: ["a1", "a2", "a3"], c2: ["b1", "b2"], c3: ["d1"] },
  cadence: 99,
  itemsPerCheck: 3,
  retryOnWrong: false,
};

/** A session in the quiz phase on the given item, so answers can be dispatched. */
function answering(fromState = createSession({ lessonId: "l", graphVersion: 1 })) {
  const state: LessonSession = { ...fromState, phase: "quiz" };
  const run = (answers: Array<[string, boolean]>) =>
    answers.reduce<LessonSession>((current, [id, correct]) => {
      const asking: LessonSession = { ...current, phase: "quiz", activeQuizItemId: id };
      return reduceSession(
        asking,
        { type: "answer", quizItemId: id, correct } as SessionAction,
        ctx,
      );
    }, state);
  return run;
}

describe("streak", () => {
  it("counts correct answers in a row and remembers the best run", () => {
    const run = answering();
    const s = run([
      ["a1", true],
      ["a2", true],
      ["b1", true],
    ]);
    expect(s.streak).toBe(3);
    expect(s.bestStreak).toBe(3);
  });

  it("goes back to zero on a wrong answer but keeps the best", () => {
    const run = answering();
    const s = run([
      ["a1", true],
      ["a2", true],
      ["b1", false],
    ]);
    expect(s.streak).toBe(0);
    expect(s.bestStreak).toBe(2);
  });

  it("starts again after a wrong answer", () => {
    const run = answering();
    const s = run([
      ["a1", true],
      ["a2", false],
      ["b1", true],
    ]);
    expect(s.streak).toBe(1);
    expect(s.bestStreak).toBe(1);
  });

  it("is not changed by an answer to a question that is not being asked", () => {
    const state = {
      ...createSession({ lessonId: "l", graphVersion: 1 }),
      phase: "quiz" as const,
      activeQuizItemId: "a1",
    };
    expect(reduceSession(state, { type: "answer", quizItemId: "zzz", correct: true }, ctx)).toBe(
      state,
    );
  });
});

describe("mastery in the session", () => {
  it("masters a concept after two correct answers in a row", () => {
    const s = answering()([
      ["a1", true],
      ["a2", true],
    ]);
    expect(masteredConceptIds(s)).toEqual(["c1"]);
  });

  it("does not master on one correct answer", () => {
    expect(masteredConceptIds(answering()([["a1", true]]))).toEqual([]);
  });

  it("returns a concept to in progress when a later answer is wrong", () => {
    const s = answering()([
      ["a1", true],
      ["a2", true],
      ["a3", false],
    ]);
    expect(masteredConceptIds(s)).toEqual([]);
    expect(s.conceptRun.c1).toBe(0);
  });

  it("needs two in a row, so wrong between two correct answers is not mastery", () => {
    const s = answering()([
      ["a1", true],
      ["a2", false],
      ["a3", true],
    ]);
    expect(masteredConceptIds(s)).toEqual([]);
  });

  it("keeps each concept's run apart", () => {
    const s = answering()([
      ["a1", true],
      ["b1", true],
      ["a2", true],
    ]);
    expect(masteredConceptIds(s)).toEqual(["c1"]);
    expect(s.conceptRun.c2).toBe(1);
  });

  it("starts empty and resets on restart", () => {
    const s = answering()([
      ["a1", true],
      ["a2", true],
    ]);
    const restarted = reduceSession(s, { type: "restart" }, ctx);
    expect(restarted).toMatchObject({ streak: 0, bestStreak: 0, conceptRun: {}, activeMs: 0 });
    expect(masteredConceptIds(restarted)).toEqual([]);
  });
});

const memory = (
  initial: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

function storeAt(clock: { t: number }, storage: StorageLike | null = memory()) {
  const graph = makeGraph();
  return createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 1,
    graph,
    getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
    storage,
    now: () => clock.t,
  });
}

describe("active time", () => {
  it("adds the time between actions", () => {
    const clock = { t: 1_000 };
    const store = storeAt(clock);
    store.getState().start();
    clock.t += 20_000;
    store.getState().next();
    clock.t += 15_000;
    store.getState().next();
    expect(store.getState().session.activeMs).toBe(35_000);
  });

  it("starts at zero and counts nothing before the first action", () => {
    const clock = { t: 9_999_999 };
    const store = storeAt(clock);
    expect(store.getState().session.activeMs).toBe(0);
    store.getState().start();
    expect(store.getState().session.activeMs).toBe(0);
  });

  it("does not count a long wait as study", () => {
    const clock = { t: 0 };
    const store = storeAt(clock);
    store.getState().start();
    clock.t += 45 * 60_000; // went for lunch
    store.getState().next();
    expect(store.getState().session.activeMs).toBe(MAX_ACTIVE_GAP_MS);
  });

  it("does not count an action that changed nothing", () => {
    const clock = { t: 0 };
    const store = storeAt(clock);
    store.getState().start();
    clock.t += 10_000;
    store.getState().previous(); // already on the first concept
    clock.t += 10_000;
    store.getState().next();
    // The ignored action did not reset the clock, so the gap is the full 20 seconds.
    expect(store.getState().session.activeMs).toBe(20_000);
  });

  it("never goes backwards if the clock does", () => {
    const clock = { t: 100_000 };
    const store = storeAt(clock);
    store.getState().start();
    clock.t = 50_000;
    store.getState().next();
    expect(store.getState().session.activeMs).toBe(0);
  });

  it("is saved with the session and restored", () => {
    const clock = { t: 0 };
    const storage = memory();
    const store = storeAt(clock, storage);
    store.getState().start();
    clock.t += 12_000;
    store.getState().next();
    const again = storeAt(clock, storage);
    again.getState().hydrate();
    expect(again.getState().session.activeMs).toBe(12_000);
  });

  it("goes back to zero when the lesson is restarted", () => {
    const clock = { t: 0 };
    const store = storeAt(clock);
    store.getState().start();
    clock.t += 12_000;
    store.getState().next();
    clock.t += 3_000;
    store.getState().restart();
    expect(store.getState().session.activeMs).toBe(0);
  });
});

describe("restoring older saved sessions", () => {
  const graph = makeGraph();
  const context = () => ({
    conceptIds: graph.concepts.map((c) => c.id),
    quizItemsByConcept: {},
    cadence: 5,
    itemsPerCheck: 1,
    retryOnWrong: false,
  });

  it("fills in the new fields for a session saved before they existed", () => {
    const fresh = createSession({ lessonId: graph.lessonId, graphVersion: 1 });
    const { streak, bestStreak, conceptRun, activeMs, ...old } = fresh;
    void [streak, bestStreak, conceptRun, activeMs];
    const restored = restoreSession({ ...old, phase: "learning" }, fresh, context());
    expect(restored).toMatchObject({ streak: 0, bestStreak: 0, conceptRun: {}, activeMs: 0 });
    expect(restored.phase).toBe("learning");
  });

  it("drops mastery for concepts that are no longer in the lesson", () => {
    const fresh = createSession({ lessonId: graph.lessonId, graphVersion: 1 });
    const known = graph.concepts[0].id;
    const restored = restoreSession(
      { ...fresh, conceptRun: { [known]: 2, gone: 2 } },
      fresh,
      context(),
    );
    expect(restored.conceptRun).toEqual({ [known]: 2 });
  });

  it("uses a key per lesson", () => {
    expect(SESSION_STORAGE_PREFIX).toMatch(/v1/);
  });
});
