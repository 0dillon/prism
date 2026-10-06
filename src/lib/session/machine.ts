/**
 * The lesson session state machine (PRD 5.5). A pure reducer: given the current state, an
 * action and the lesson's shape, it returns the next state. Renderers never decide what
 * happens next; they dispatch actions and draw the state. That is why switching layout
 * mid-lesson keeps the learner's place, and why every renderer behaves the same.
 *
 *   intro --start--> learning
 *   learning --next (conceptsSinceQuiz < cadence)--> learning
 *   learning --next (conceptsSinceQuiz >= cadence) or quiz_me--> quiz
 *   quiz --answer--> feedback
 *   feedback --continue (wrong and retryOnWrong)--> quiz (same concept, different item)
 *   feedback --continue (more concepts)--> learning
 *   feedback --continue (no more concepts)--> complete
 */

export type SessionPhase = "intro" | "learning" | "quiz" | "feedback" | "complete";

export interface LessonSession {
  lessonId: string;
  graphVersion: number;
  phase: SessionPhase;
  /** Position in the ordered concepts. */
  conceptIndex: number;
  seenConceptIds: string[];
  conceptsSinceQuiz: number;
  activeQuizItemId: string | null;
  lastAnswer: { quizItemId: string; correct: boolean } | null;
  startedAt: number;

  /** Concepts viewed since the last quiz, oldest first. Their items are what the next quiz asks. */
  sinceQuizConceptIds: string[];
  /** Items still to ask in the current quiz, after the active one. */
  quizQueue: string[];
  /** Every item asked so far, so a quiz prefers questions the learner has not seen. */
  askedItemIds: string[];
  /** Whether the active item is a retry after a wrong answer, so a retry is never retried. */
  activeIsRetry: boolean;
  /** Where to go when the current quiz ends: on to the next concept, or back to this one. */
  afterQuiz: "advance" | "stay";
  /** How many questions have been answered correctly, for the completion summary. */
  correctCount: number;
  answeredCount: number;
  /** Correct answers in a row right now, and the longest run this lesson. */
  streak: number;
  bestStreak: number;
  /**
   * Correct answers in a row on each concept's questions. Two in a row is mastered and a
   * wrong answer starts the count again (PRD 5.7), so the summary agrees with the database.
   */
  conceptRun: Record<string, number>;
  /** Active time in milliseconds. Kept by the store, which can see the clock; the reducer is pure. */
  activeMs: number;
}

/** What the machine needs to know about the lesson and the learner's profile. */
export interface SessionContext {
  /** Concept ids in teaching order. */
  conceptIds: readonly string[];
  /** Quiz item ids for each concept, in the order they should be preferred. */
  quizItemsByConcept: Readonly<Record<string, readonly string[]>>;
  cadence: number;
  itemsPerCheck: number;
  retryOnWrong: boolean;
}

export type SessionAction =
  | { type: "start"; now?: number }
  | { type: "next" }
  | { type: "previous" }
  | { type: "request_quiz" }
  | { type: "answer"; quizItemId: string; correct: boolean }
  | { type: "continue" }
  | { type: "go_to"; conceptIndex: number }
  | { type: "restart"; now?: number };

export function createSession(options: {
  lessonId: string;
  graphVersion: number;
  now?: number;
}): LessonSession {
  return {
    lessonId: options.lessonId,
    graphVersion: options.graphVersion,
    phase: "intro",
    conceptIndex: 0,
    seenConceptIds: [],
    conceptsSinceQuiz: 0,
    activeQuizItemId: null,
    lastAnswer: null,
    startedAt: options.now ?? Date.now(),
    sinceQuizConceptIds: [],
    quizQueue: [],
    askedItemIds: [],
    activeIsRetry: false,
    afterQuiz: "advance",
    correctCount: 0,
    answeredCount: 0,
    streak: 0,
    bestStreak: 0,
    conceptRun: {},
    activeMs: 0,
  };
}

/** Correct answers in a row on one concept that make it mastered (PRD 5.7). */
export const MASTERY_RUN = 2;

/** Concept ids the learner has mastered so far in this session. */
export function masteredConceptIds(state: LessonSession): string[] {
  return Object.entries(state.conceptRun)
    .filter(([, run]) => run >= MASTERY_RUN)
    .map(([id]) => id);
}

const unique = <T>(items: T[]) => [...new Set(items)];

function conceptOfItem(ctx: SessionContext, itemId: string): string | null {
  for (const [conceptId, items] of Object.entries(ctx.quizItemsByConcept)) {
    if (items.includes(itemId)) return conceptId;
  }
  return null;
}

/** Marks the concept at `index` as seen and counts it towards the next quiz. */
function view(state: LessonSession, ctx: SessionContext, index: number): LessonSession {
  const id = ctx.conceptIds[index];
  const alreadyThisRound = state.sinceQuizConceptIds.includes(id);
  return {
    ...state,
    phase: "learning",
    conceptIndex: index,
    seenConceptIds: unique([...state.seenConceptIds, id]),
    sinceQuizConceptIds: alreadyThisRound
      ? state.sinceQuizConceptIds
      : [...state.sinceQuizConceptIds, id],
    conceptsSinceQuiz: alreadyThisRound ? state.conceptsSinceQuiz : state.conceptsSinceQuiz + 1,
    activeQuizItemId: null,
    quizQueue: [],
    activeIsRetry: false,
  };
}

/**
 * The items for the next quiz: up to `itemsPerCheck`, drawn from the concepts viewed since
 * the last quiz, newest first, preferring questions not asked before. Empty if those
 * concepts have no questions.
 */
export function selectQuizItems(state: LessonSession, ctx: SessionContext): string[] {
  const recent = [...state.sinceQuizConceptIds].reverse();
  const candidates = recent.flatMap((conceptId) => ctx.quizItemsByConcept[conceptId] ?? []);
  const fresh = candidates.filter((id) => !state.askedItemIds.includes(id));
  const chosen: string[] = [];
  const take = (pool: string[]) => {
    for (const id of pool) {
      if (chosen.length >= ctx.itemsPerCheck) return;
      if (!chosen.includes(id)) chosen.push(id);
    }
  };
  take(fresh);
  take(candidates);
  return chosen;
}

function startQuiz(
  state: LessonSession,
  ctx: SessionContext,
  afterQuiz: "advance" | "stay",
): LessonSession | null {
  const items = selectQuizItems(state, ctx);
  if (items.length === 0) return null;
  const [first, ...rest] = items;
  return {
    ...state,
    phase: "quiz",
    activeQuizItemId: first,
    quizQueue: rest,
    askedItemIds: unique([...state.askedItemIds, first]),
    activeIsRetry: false,
    lastAnswer: null,
    afterQuiz,
  };
}

/** Called when a quiz has no more questions: go on, back, or finish. */
function finishQuiz(state: LessonSession, ctx: SessionContext): LessonSession {
  const reset: LessonSession = {
    ...state,
    conceptsSinceQuiz: 0,
    sinceQuizConceptIds: [],
    quizQueue: [],
    activeQuizItemId: null,
    activeIsRetry: false,
  };
  if (state.afterQuiz === "stay") return { ...reset, phase: "learning" };
  const nextIndex = state.conceptIndex + 1;
  if (nextIndex < ctx.conceptIds.length) return view(reset, ctx, nextIndex);
  return { ...reset, phase: "complete", lastAnswer: state.lastAnswer };
}

export function reduceSession(
  state: LessonSession,
  action: SessionAction,
  ctx: SessionContext,
): LessonSession {
  switch (action.type) {
    case "start": {
      if (state.phase !== "intro" || ctx.conceptIds.length === 0) return state;
      return { ...view(state, ctx, 0), startedAt: action.now ?? state.startedAt };
    }

    case "restart":
      return createSession({
        lessonId: state.lessonId,
        graphVersion: state.graphVersion,
        now: action.now,
      });

    case "next": {
      if (state.phase !== "learning") return state;
      const isLast = state.conceptIndex >= ctx.conceptIds.length - 1;

      // A quiz is due once enough concepts have been seen, and also at the very end.
      if (state.conceptsSinceQuiz >= ctx.cadence || isLast) {
        const quiz = startQuiz(state, ctx, "advance");
        if (quiz) return quiz;
        // Nothing to ask: skip the quiz and carry on.
        if (isLast) return { ...state, phase: "complete" };
        return view(
          { ...state, conceptsSinceQuiz: 0, sinceQuizConceptIds: [] },
          ctx,
          state.conceptIndex + 1,
        );
      }
      return view(state, ctx, state.conceptIndex + 1);
    }

    case "previous": {
      if (state.phase !== "learning" || state.conceptIndex === 0) return state;
      const index = state.conceptIndex - 1;
      // Going back does not change how many concepts count towards the next quiz.
      return {
        ...state,
        conceptIndex: index,
        seenConceptIds: unique([...state.seenConceptIds, ctx.conceptIds[index]]),
      };
    }

    case "request_quiz": {
      if (state.phase !== "learning") return state;
      // Make sure the concept on screen counts, then ask about what has been seen.
      const current = ctx.conceptIds[state.conceptIndex];
      const seen: LessonSession = state.sinceQuizConceptIds.includes(current)
        ? state
        : {
            ...state,
            sinceQuizConceptIds: [...state.sinceQuizConceptIds, current],
            conceptsSinceQuiz: state.conceptsSinceQuiz + 1,
          };
      return startQuiz(seen, ctx, "stay") ?? state;
    }

    case "answer": {
      if (state.phase !== "quiz" || state.activeQuizItemId !== action.quizItemId) return state;
      const streak = action.correct ? state.streak + 1 : 0;
      const conceptId = conceptOfItem(ctx, action.quizItemId);
      return {
        ...state,
        phase: "feedback",
        lastAnswer: { quizItemId: action.quizItemId, correct: action.correct },
        answeredCount: state.answeredCount + 1,
        correctCount: state.correctCount + (action.correct ? 1 : 0),
        streak,
        bestStreak: Math.max(state.bestStreak, streak),
        conceptRun: conceptId
          ? {
              ...state.conceptRun,
              [conceptId]: action.correct ? (state.conceptRun[conceptId] ?? 0) + 1 : 0,
            }
          : state.conceptRun,
      };
    }

    case "continue": {
      if (state.phase !== "feedback" || !state.lastAnswer) return state;

      // Wrong, and the learner wants another go: a different question on the same concept.
      if (!state.lastAnswer.correct && ctx.retryOnWrong && !state.activeIsRetry) {
        const conceptId = conceptOfItem(ctx, state.lastAnswer.quizItemId);
        const siblings = conceptId ? (ctx.quizItemsByConcept[conceptId] ?? []) : [];
        const retry = siblings.find(
          (id) => id !== state.lastAnswer?.quizItemId && !state.askedItemIds.includes(id),
        );
        if (retry) {
          return {
            ...state,
            phase: "quiz",
            activeQuizItemId: retry,
            askedItemIds: unique([...state.askedItemIds, retry]),
            activeIsRetry: true,
          };
        }
      }

      if (state.quizQueue.length > 0) {
        const [nextItem, ...rest] = state.quizQueue;
        return {
          ...state,
          phase: "quiz",
          activeQuizItemId: nextItem,
          quizQueue: rest,
          askedItemIds: unique([...state.askedItemIds, nextItem]),
          activeIsRetry: false,
        };
      }
      return finishQuiz(state, ctx);
    }

    case "go_to": {
      if (state.phase !== "learning") return state;
      const index = Math.min(
        Math.max(Math.trunc(action.conceptIndex), 0),
        ctx.conceptIds.length - 1,
      );
      if (!Number.isFinite(index) || index === state.conceptIndex) return state;
      return {
        ...state,
        conceptIndex: index,
        seenConceptIds: unique([...state.seenConceptIds, ctx.conceptIds[index]]),
      };
    }
  }
}

/** Whole-lesson progress for a progress bar: concepts seen over concepts in the lesson. */
export function sessionProgress(state: LessonSession, ctx: SessionContext): number {
  if (ctx.conceptIds.length === 0) return 0;
  if (state.phase === "complete") return 1;
  return state.seenConceptIds.length / ctx.conceptIds.length;
}
