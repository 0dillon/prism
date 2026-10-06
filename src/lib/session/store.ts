import { useEffect } from "react";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import {
  createSession,
  reduceSession,
  type LessonSession,
  type SessionAction,
  type SessionContext,
} from "./machine";

/**
 * The lesson session store (PRD 5.5). It wraps the pure reducer in machine.ts and keeps
 * the learner's place for one lesson. Renderers are views over this store and hold no
 * progress of their own, so changing layout mid-lesson changes nothing here.
 */

export const SESSION_STORAGE_PREFIX = "prism.session.v1.";

const SessionSchema = z.object({
  lessonId: z.string(),
  graphVersion: z.number().int(),
  phase: z.enum(["intro", "learning", "quiz", "feedback", "complete"]),
  conceptIndex: z.number().int().min(0),
  seenConceptIds: z.array(z.string()),
  conceptsSinceQuiz: z.number().int().min(0),
  activeQuizItemId: z.string().nullable(),
  lastAnswer: z.object({ quizItemId: z.string(), correct: z.boolean() }).nullable(),
  startedAt: z.number(),
  sinceQuizConceptIds: z.array(z.string()),
  quizQueue: z.array(z.string()),
  askedItemIds: z.array(z.string()),
  activeIsRetry: z.boolean(),
  afterQuiz: z.enum(["advance", "stay"]),
  correctCount: z.number().int().min(0),
  answeredCount: z.number().int().min(0),
});

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** The quiz settings the machine needs. They come from the learner's profile and can change at any time. */
export type QuizSettings = Pick<SessionContext, "cadence" | "itemsPerCheck" | "retryOnWrong">;

export interface SessionStoreOptions {
  lessonId: string;
  graphVersion: number;
  graph: Pick<KnowledgeGraph, "concepts" | "quizItems">;
  /** Read on every action, so a profile change takes effect immediately. */
  getSettings: () => QuizSettings;
  storage?: StorageLike | null;
  now?: () => number;
}

export interface SessionStoreState {
  session: LessonSession;
  hydrated: boolean;
}

export interface SessionStoreActions {
  start(): void;
  next(): void;
  previous(): void;
  requestQuiz(): void;
  answer(quizItemId: string, correct: boolean): void;
  continue(): void;
  goTo(conceptIndex: number): void;
  restart(): void;
  /** Applies an action. The named methods above are shorthand for this. */
  dispatch(action: SessionAction): void;
  /** Restores a saved session for this lesson, if there is a usable one. */
  hydrate(): void;
  /** The machine's view of the lesson with the current quiz settings. */
  context(): SessionContext;
}

export type SessionStore = SessionStoreState & SessionStoreActions;

function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    const probe = "__prism_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Builds the machine's context from the lesson graph and the learner's quiz settings. */
export function buildContext(
  graph: Pick<KnowledgeGraph, "concepts" | "quizItems">,
  settings: QuizSettings,
): SessionContext {
  const ordered = [...graph.concepts].sort((a, b) => a.order - b.order);
  const byConcept: Record<string, string[]> = {};
  for (const concept of ordered) byConcept[concept.id] = [];
  for (const item of graph.quizItems) byConcept[item.conceptId]?.push(item.id);
  return {
    conceptIds: ordered.map((c) => c.id),
    quizItemsByConcept: byConcept,
    ...settings,
  };
}

/**
 * Checks that a saved session still makes sense for this lesson. A saved session from an
 * older version of the lesson is kept where it still fits and repaired where it does not.
 */
export function restoreSession(
  saved: unknown,
  fresh: LessonSession,
  ctx: SessionContext,
): LessonSession {
  const parsed = SessionSchema.safeParse(saved);
  if (!parsed.success || parsed.data.lessonId !== fresh.lessonId) return fresh;

  const known = new Set(ctx.conceptIds);
  const items = new Set(Object.values(ctx.quizItemsByConcept).flat());
  const s = parsed.data;
  if (s.conceptIndex >= ctx.conceptIds.length) return fresh;

  const repaired: LessonSession = {
    ...s,
    graphVersion: fresh.graphVersion,
    seenConceptIds: s.seenConceptIds.filter((id) => known.has(id)),
    sinceQuizConceptIds: s.sinceQuizConceptIds.filter((id) => known.has(id)),
    quizQueue: s.quizQueue.filter((id) => items.has(id)),
    askedItemIds: s.askedItemIds.filter((id) => items.has(id)),
  };
  repaired.conceptsSinceQuiz = repaired.sinceQuizConceptIds.length;

  // A question that no longer exists cannot be answered, so fall back to reading.
  const needsItem =
    repaired.phase === "quiz" &&
    (!repaired.activeQuizItemId || !items.has(repaired.activeQuizItemId));
  const brokenFeedback = repaired.phase === "feedback" && !repaired.lastAnswer;
  if (needsItem || brokenFeedback) {
    return {
      ...repaired,
      phase: "learning",
      activeQuizItemId: null,
      quizQueue: [],
      activeIsRetry: false,
    };
  }
  return repaired;
}

export function createSessionStore(options: SessionStoreOptions): StoreApi<SessionStore> {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const key = `${SESSION_STORAGE_PREFIX}${options.lessonId}`;
  const now = options.now ?? Date.now;
  const context = () => buildContext(options.graph, options.getSettings());
  const fresh = () =>
    createSession({ lessonId: options.lessonId, graphVersion: options.graphVersion, now: now() });

  const store = createStore<SessionStore>((set, get) => ({
    session: fresh(),
    hydrated: false,

    dispatch(action) {
      const withTime =
        action.type === "start" || action.type === "restart" ? { ...action, now: now() } : action;
      const next = reduceSession(get().session, withTime, context());
      if (next !== get().session) set({ session: next });
    },

    start: () => get().dispatch({ type: "start" }),
    next: () => get().dispatch({ type: "next" }),
    previous: () => get().dispatch({ type: "previous" }),
    requestQuiz: () => get().dispatch({ type: "request_quiz" }),
    answer: (quizItemId, correct) => get().dispatch({ type: "answer", quizItemId, correct }),
    continue: () => get().dispatch({ type: "continue" }),
    goTo: (conceptIndex) => get().dispatch({ type: "go_to", conceptIndex }),
    restart: () => get().dispatch({ type: "restart" }),
    context,

    hydrate() {
      let saved: unknown = null;
      try {
        const raw = storage?.getItem(key);
        saved = raw ? JSON.parse(raw) : null;
      } catch {
        saved = null;
      }
      set({
        hydrated: true,
        session: saved ? restoreSession(saved, fresh(), context()) : get().session,
      });
    },
  }));

  // Remember the place after every change. Never let storage trouble affect the lesson.
  store.subscribe((state, previous) => {
    if (state.session === previous.session) return;
    try {
      storage?.setItem(key, JSON.stringify(state.session));
    } catch {
      // Ignore: the session still works in memory.
    }
  });

  return store;
}

export function useSession<T>(
  store: StoreApi<SessionStore>,
  selector: (state: SessionStore) => T,
): T {
  return useStore(store, selector);
}

/** Loads the saved session after the first render, so server and client markup match. */
export function useSessionHydration(store: StoreApi<SessionStore>): void {
  useEffect(() => {
    if (!store.getState().hydrated) store.getState().hydrate();
  }, [store]);
}
