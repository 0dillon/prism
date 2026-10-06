import { describe, expect, it } from "vitest";
import {
  createSession,
  reduceSession,
  selectQuizItems,
  sessionProgress,
  type LessonSession,
  type SessionAction,
  type SessionContext,
} from "@/lib/session/machine";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i + 1}`);

type ContextOptions = Partial<SessionContext> & { concepts?: number; itemsEach?: number };

function context(overrides: ContextOptions = {}): SessionContext {
  const conceptIds = ids(overrides.concepts ?? 6);
  const itemsEach = overrides.itemsEach ?? 2;
  return {
    conceptIds,
    quizItemsByConcept: Object.fromEntries(
      conceptIds.map((c) => [c, Array.from({ length: itemsEach }, (_, i) => `${c}_q${i + 1}`)]),
    ),
    cadence: 3,
    itemsPerCheck: 1,
    retryOnWrong: true,
    ...overrides,
  };
}

const fresh = () => createSession({ lessonId: "lesson", graphVersion: 1, now: 1000 });

function run(ctx: SessionContext, ...actions: SessionAction[]): LessonSession {
  return actions.reduce((state, action) => reduceSession(state, action, ctx), fresh());
}

const start = { type: "start" } as const;
const next = { type: "next" } as const;
const cont = { type: "continue" } as const;
const answer = (quizItemId: string, correct: boolean) =>
  ({ type: "answer", quizItemId, correct }) as const;

describe("start", () => {
  it("moves from intro to learning on the first concept", () => {
    const state = run(context(), start);
    expect(state).toMatchObject({
      phase: "learning",
      conceptIndex: 0,
      seenConceptIds: ["c1"],
      conceptsSinceQuiz: 1,
    });
  });

  it("records the start time it is given", () => {
    expect(reduceSession(fresh(), { type: "start", now: 5555 }, context()).startedAt).toBe(5555);
  });

  it("does nothing if already started, or if the lesson has no concepts", () => {
    const ctx = context();
    const started = run(ctx, start);
    expect(reduceSession(started, start, ctx)).toBe(started);
    expect(reduceSession(fresh(), start, context({ concepts: 0 }))).toMatchObject({
      phase: "intro",
    });
  });
});

describe("next: advancing through concepts", () => {
  it("moves to the next concept while below the cadence", () => {
    const state = run(context(), start, next);
    expect(state).toMatchObject({ phase: "learning", conceptIndex: 1, conceptsSinceQuiz: 2 });
    expect(state.seenConceptIds).toEqual(["c1", "c2"]);
  });

  it("shows a quiz after `cadence` concepts, before advancing", () => {
    const state = run(context({ cadence: 3 }), start, next, next, next);
    expect(state.phase).toBe("quiz");
    expect(state.conceptIndex).toBe(2); // still on the third concept
    expect(state.activeQuizItemId).toBe("c3_q1");
  });

  it("honors a cadence of one: a quiz after every concept", () => {
    const state = run(context({ cadence: 1 }), start, next);
    expect(state).toMatchObject({ phase: "quiz", conceptIndex: 0 });
  });

  it("only ignores `next` outside the learning phase", () => {
    const ctx = context({ cadence: 1 });
    const quiz = run(ctx, start, next);
    expect(reduceSession(quiz, next, ctx)).toBe(quiz);
    expect(reduceSession(fresh(), next, ctx)).toMatchObject({ phase: "intro" });
  });
});

describe("quiz: answering", () => {
  const atQuiz = () => {
    const ctx = context({ cadence: 2 });
    return { ctx, state: run(ctx, start, next, next) }; // quiz after c1, c2
  };

  it("moves to feedback and records the answer", () => {
    const { ctx, state } = atQuiz();
    const answered = reduceSession(state, answer("c2_q1", true), ctx);
    expect(answered).toMatchObject({
      phase: "feedback",
      lastAnswer: { quizItemId: "c2_q1", correct: true },
      answeredCount: 1,
      correctCount: 1,
    });
  });

  it("counts a wrong answer without counting it correct", () => {
    const { ctx, state } = atQuiz();
    const answered = reduceSession(state, answer("c2_q1", false), ctx);
    expect(answered).toMatchObject({ answeredCount: 1, correctCount: 0 });
  });

  it("ignores an answer to a question that is not the active one, or outside a quiz", () => {
    const { ctx, state } = atQuiz();
    expect(reduceSession(state, answer("c1_q1", true), ctx)).toBe(state);
    expect(reduceSession(run(ctx, start), answer("c1_q1", true), ctx)).toMatchObject({
      phase: "learning",
    });
  });
});

describe("feedback: continue", () => {
  const afterAnswer = (correct: boolean, ctxOverrides: ContextOptions = {}) => {
    const ctx = context({ cadence: 2, ...ctxOverrides });
    const state = run(ctx, start, next, next, answer("c2_q1", correct));
    return { ctx, state };
  };

  it("after a correct answer goes on to the next concept and resets the counter", () => {
    const { ctx, state } = afterAnswer(true);
    const after = reduceSession(state, cont, ctx);
    expect(after).toMatchObject({
      phase: "learning",
      conceptIndex: 2,
      conceptsSinceQuiz: 1,
      activeQuizItemId: null,
    });
    expect(after.seenConceptIds).toEqual(["c1", "c2", "c3"]);
    expect(after.sinceQuizConceptIds).toEqual(["c3"]);
  });

  it("after a wrong answer with retry on, asks a different question on the same concept", () => {
    const { ctx, state } = afterAnswer(false);
    const retry = reduceSession(state, cont, ctx);
    expect(retry).toMatchObject({
      phase: "quiz",
      activeQuizItemId: "c2_q2",
      activeIsRetry: true,
      conceptIndex: 1,
    });
  });

  it("goes on after the retry, whatever the result", () => {
    for (const correct of [true, false]) {
      const { ctx, state } = afterAnswer(false);
      const retry = reduceSession(state, cont, ctx);
      const answered = reduceSession(retry, answer("c2_q2", correct), ctx);
      const after = reduceSession(answered, cont, ctx);
      expect(after.phase).toBe("learning");
      expect(after.conceptIndex).toBe(2);
    }
  });

  it("never retries a retry: a wrong retry moves on", () => {
    const { ctx, state } = afterAnswer(false);
    const retry = reduceSession(state, cont, ctx);
    const wrongAgain = reduceSession(retry, answer("c2_q2", false), ctx);
    expect(reduceSession(wrongAgain, cont, ctx).phase).toBe("learning");
  });

  it("goes on after a wrong answer when retry is off", () => {
    const { ctx, state } = afterAnswer(false, { retryOnWrong: false });
    expect(reduceSession(state, cont, ctx)).toMatchObject({ phase: "learning", conceptIndex: 2 });
  });

  it("goes on when the concept has no other question to retry with", () => {
    const { ctx, state } = afterAnswer(false, { itemsEach: 1 });
    expect(reduceSession(state, cont, ctx)).toMatchObject({ phase: "learning", conceptIndex: 2 });
  });

  it("does nothing outside feedback", () => {
    const ctx = context();
    const learning = run(ctx, start);
    expect(reduceSession(learning, cont, ctx)).toBe(learning);
  });
});

describe("the end of the lesson", () => {
  it("shows a final quiz on the last concept and then completes", () => {
    const ctx = context({ concepts: 3, cadence: 10 });
    let state = run(ctx, start, next, next); // on c3, the last
    expect(state.phase).toBe("learning");
    state = reduceSession(state, next, ctx);
    expect(state.phase).toBe("quiz"); // a final check even though the cadence was not reached
    state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
    state = reduceSession(state, cont, ctx);
    expect(state.phase).toBe("complete");
    expect(sessionProgress(state, ctx)).toBe(1);
  });

  it("completes right away if the last concept has no questions", () => {
    const ctx = context({ concepts: 2, cadence: 10, itemsEach: 0 });
    expect(run(ctx, start, next, next).phase).toBe("complete");
  });

  it("completes after a cadence quiz that falls on the last concept", () => {
    const ctx = context({ concepts: 3, cadence: 3 });
    let state = run(ctx, start, next, next, next);
    expect(state.phase).toBe("quiz");
    state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
    expect(reduceSession(state, cont, ctx).phase).toBe("complete");
  });

  it("completes a one-concept lesson", () => {
    const ctx = context({ concepts: 1 });
    let state = run(ctx, start, next);
    expect(state.phase).toBe("quiz");
    state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
    expect(reduceSession(state, cont, ctx).phase).toBe("complete");
  });

  it("ignores everything but restart once complete", () => {
    const ctx = context({ concepts: 1 });
    let state = run(ctx, start, next);
    state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
    const done = reduceSession(state, cont, ctx);
    for (const action of [
      start,
      next,
      cont,
      { type: "previous" } as const,
      { type: "request_quiz" } as const,
    ]) {
      expect(reduceSession(done, action, ctx)).toBe(done);
    }
  });

  it("restart returns to the intro with nothing remembered", () => {
    const ctx = context({ concepts: 1 });
    const done = run(ctx, start, next, answer("c1_q1", true), cont);
    const again = reduceSession(done, { type: "restart", now: 9 }, ctx);
    expect(again).toMatchObject({
      phase: "intro",
      seenConceptIds: [],
      answeredCount: 0,
      startedAt: 9,
    });
  });
});

describe("request_quiz (a learner asks to be quizzed)", () => {
  it("starts a quiz on what has been seen and returns to the same concept afterwards", () => {
    const ctx = context({ cadence: 5 });
    let state = run(ctx, start, next); // on c2, two seen
    state = reduceSession(state, { type: "request_quiz" }, ctx);
    expect(state).toMatchObject({ phase: "quiz", conceptIndex: 1, afterQuiz: "stay" });
    state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
    state = reduceSession(state, cont, ctx);
    expect(state).toMatchObject({ phase: "learning", conceptIndex: 1, conceptsSinceQuiz: 0 });
  });

  it("restarts the cadence count afterwards", () => {
    const ctx = context({ cadence: 2 });
    let state = run(ctx, start, { type: "request_quiz" });
    state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
    state = reduceSession(state, cont, ctx); // back on c1, count 0
    state = reduceSession(state, next, ctx); // c2, count 1: no quiz yet
    expect(state.phase).toBe("learning");
  });

  it("does nothing when there is nothing to ask about", () => {
    const ctx = context({ itemsEach: 0 });
    const state = run(ctx, start);
    expect(reduceSession(state, { type: "request_quiz" }, ctx)).toBe(state);
  });

  it("does nothing outside the learning phase", () => {
    expect(reduceSession(fresh(), { type: "request_quiz" }, context())).toMatchObject({
      phase: "intro",
    });
  });
});

describe("itemsPerCheck", () => {
  it("asks that many questions in a row before moving on", () => {
    const ctx = context({ cadence: 2, itemsPerCheck: 3 });
    let state = run(ctx, start, next, next);
    const asked: string[] = [];
    while (state.phase === "quiz") {
      asked.push(state.activeQuizItemId as string);
      state = reduceSession(state, answer(state.activeQuizItemId as string, true), ctx);
      state = reduceSession(state, cont, ctx);
    }
    expect(asked).toHaveLength(3);
    expect(new Set(asked).size).toBe(3);
    expect(state).toMatchObject({ phase: "learning", conceptIndex: 2 });
  });

  it("draws from the concepts seen since the last quiz, newest first", () => {
    const ctx = context({ cadence: 3, itemsPerCheck: 2 });
    const state = run(ctx, start, next, next, next);
    expect(selectQuizItems({ ...state, askedItemIds: [] }, ctx)).toEqual(["c3_q1", "c3_q2"]);
  });

  it("prefers questions not asked before, and repeats only when it must", () => {
    const ctx = context({ cadence: 1, itemsPerCheck: 1, itemsEach: 2 });
    let state = run(ctx, start, next);
    expect(state.activeQuizItemId).toBe("c1_q1");
    state = reduceSession(state, answer("c1_q1", true), ctx);
    state = reduceSession(state, cont, ctx);
    state = reduceSession(state, { type: "previous" }, ctx);
    state = reduceSession(state, { type: "request_quiz" }, ctx);
    expect(state.activeQuizItemId).toBe("c1_q2"); // the fresh one first
  });

  it("asks fewer questions when there are not enough", () => {
    const ctx = context({ cadence: 1, itemsPerCheck: 5, itemsEach: 1 });
    expect(selectQuizItems(run(ctx, start), ctx)).toEqual(["c1_q1"]);
  });
});

describe("previous and go_to", () => {
  it("goes back one concept without changing the quiz counter", () => {
    const ctx = context();
    const state = run(ctx, start, next, { type: "previous" });
    expect(state).toMatchObject({ phase: "learning", conceptIndex: 0, conceptsSinceQuiz: 2 });
  });

  it("does not go back from the first concept", () => {
    const ctx = context();
    const state = run(ctx, start);
    expect(reduceSession(state, { type: "previous" }, ctx)).toBe(state);
  });

  it("does not count a revisited concept twice towards the next quiz", () => {
    const ctx = context({ cadence: 3 });
    const state = run(ctx, start, next, { type: "previous" }, next);
    expect(state).toMatchObject({ conceptIndex: 1, conceptsSinceQuiz: 2 });
  });

  it("ignores previous in a quiz", () => {
    const ctx = context({ cadence: 1 });
    const quiz = run(ctx, start, next);
    expect(reduceSession(quiz, { type: "previous" }, ctx)).toBe(quiz);
  });

  it("jumps to a concept, clamping to the lesson, and marks it seen", () => {
    const ctx = context();
    const state = run(ctx, start);
    expect(reduceSession(state, { type: "go_to", conceptIndex: 4 }, ctx)).toMatchObject({
      conceptIndex: 4,
    });
    expect(reduceSession(state, { type: "go_to", conceptIndex: 99 }, ctx).conceptIndex).toBe(5);
    expect(reduceSession(state, { type: "go_to", conceptIndex: -3 }, ctx)).toBe(state);
    expect(reduceSession(state, { type: "go_to", conceptIndex: NaN }, ctx)).toBe(state);
    expect(reduceSession(state, { type: "go_to", conceptIndex: 4 }, ctx).seenConceptIds).toContain(
      "c5",
    );
  });
});

describe("progress", () => {
  it("is the share of concepts seen, and 1 when complete", () => {
    const ctx = context({ concepts: 4, cadence: 10 });
    expect(sessionProgress(fresh(), ctx)).toBe(0);
    expect(sessionProgress(run(ctx, start), ctx)).toBe(0.25);
    expect(sessionProgress(run(ctx, start, next, next), ctx)).toBe(0.75);
  });

  it("is 0 for a lesson with no concepts", () => {
    expect(sessionProgress(fresh(), context({ concepts: 0 }))).toBe(0);
  });
});

describe("purity", () => {
  it("never mutates the state it is given", () => {
    const ctx = context({ cadence: 2 });
    const states: LessonSession[] = [fresh()];
    const actions: SessionAction[] = [
      start,
      next,
      next,
      answer("c2_q1", false),
      cont,
      answer("c2_q2", true),
      cont,
    ];
    for (const action of actions) {
      const before = JSON.stringify(states.at(-1));
      const out = reduceSession(states.at(-1) as LessonSession, action, ctx);
      expect(JSON.stringify(states.at(-1))).toBe(before);
      states.push(out);
    }
  });

  it("is deterministic", () => {
    const ctx = context();
    expect(run(ctx, start, next, next, next)).toEqual(run(ctx, start, next, next, next));
  });
});

describe("invariants over many random walks", () => {
  it("always leaves a consistent state", () => {
    let seed = 42;
    const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let walk = 0; walk < 200; walk++) {
      const ctx = context({
        concepts: 1 + Math.floor(random() * 6),
        cadence: 1 + Math.floor(random() * 4),
        itemsPerCheck: 1 + Math.floor(random() * 3),
        itemsEach: Math.floor(random() * 3),
        retryOnWrong: random() > 0.5,
      });
      let state = reduceSession(fresh(), start, ctx);
      for (let step = 0; step < 60; step++) {
        const options: SessionAction[] = [
          next,
          cont,
          { type: "previous" },
          { type: "request_quiz" },
        ];
        if (state.activeQuizItemId) options.push(answer(state.activeQuizItemId, random() > 0.5));
        options.push({ type: "go_to", conceptIndex: Math.floor(random() * 8) });
        state = reduceSession(state, options[Math.floor(random() * options.length)], ctx);

        expect(state.conceptIndex).toBeGreaterThanOrEqual(0);
        expect(state.conceptIndex).toBeLessThan(Math.max(ctx.conceptIds.length, 1));
        expect(new Set(state.seenConceptIds).size).toBe(state.seenConceptIds.length);
        expect(state.conceptsSinceQuiz).toBe(state.sinceQuizConceptIds.length);
        expect(state.correctCount).toBeLessThanOrEqual(state.answeredCount);
        expect(
          state.phase === "quiz" || state.phase === "feedback"
            ? state.activeQuizItemId !== null || state.phase === "feedback"
            : true,
        ).toBe(true);
        if (state.phase === "quiz") expect(state.activeQuizItemId).not.toBeNull();
        if (state.phase === "learning") expect(state.activeQuizItemId).toBeNull();
        if (state.phase === "complete") break;
      }
    }
  });
});
