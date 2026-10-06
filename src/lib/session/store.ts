import { useEffect } from "react";
import { z } from "zod";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import type { TrackInput } from "./events";
import { deriveEvents, type OpenView } from "./telemetry";
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
  // Added after the first release, so a session saved before then still loads.
  streak: z.number().int().min(0).default(0),
  bestStreak: z.number().int().min(0).default(0),
  conceptRun: z.record(z.string(), z.number().int().min(0)).default({}),
  activeMs: z.number().min(0).default(0),
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
  /**
   * Receives each learning event the lesson produces (PRD 5.7). The store raises them, not
   * the renderers, so every layout reports the same events. Leave it out to report nothing.
   */
  onEvent?: (event: TrackInput) => void;
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
  /**
   * The learner has left the screen (tab hidden, page closing). Counts the time up to now,
   * stops the clock, and reports the idea being read so far, so nothing is lost if the page
   * never comes back.
   */
  suspend(): void;
  /** The learner is back. Time away is not counted, and a new view of the idea begins. */
  resume(): void;
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
    conceptRun: Object.fromEntries(Object.entries(s.conceptRun).filter(([id]) => known.has(id))),
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

/** The longest gap between two actions that still counts as active time. */
export const MAX_ACTIVE_GAP_MS = 60_000;

export function createSessionStore(options: SessionStoreOptions): StoreApi<SessionStore> {
  let lastActionAt: number | null = null;
  // The idea the learner is on, so the time spent on it can be reported when they leave.
  let openView: OpenView | null = null;
  let suspended = false;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const key = `${SESSION_STORAGE_PREFIX}${options.lessonId}`;
  const now = options.now ?? Date.now;
  const context = () => buildContext(options.graph, options.getSettings());
  const fresh = () =>
    createSession({ lessonId: options.lessonId, graphVersion: options.graphVersion, now: now() });

  const eventContext = () => {
    const ctx = context();
    const owner = new Map<string, string>();
    for (const [conceptId, items] of Object.entries(ctx.quizItemsByConcept)) {
      for (const id of items) owner.set(id, conceptId);
    }
    return { conceptIds: ctx.conceptIds, conceptOfItem: (id: string) => owner.get(id) };
  };

  const store = createStore<SessionStore>((set, get) => ({
    session: fresh(),
    hydrated: false,

    dispatch(action) {
      const time = now();
      const withTime =
        action.type === "start" || action.type === "restart" ? { ...action, now: time } : action;
      const reduced = reduceSession(get().session, withTime, context());
      if (reduced === get().session) return;
      // Time since the last thing the learner did counts as active, up to a cap, so a
      // walk away from the screen does not count as study (PRD 5.7). A fresh lesson starts at zero.
      const gap =
        lastActionAt === null ? 0 : Math.min(Math.max(time - lastActionAt, 0), MAX_ACTIVE_GAP_MS);
      lastActionAt = time;
      const before = get().session;
      const next = {
        ...reduced,
        activeMs: action.type === "restart" ? 0 : reduced.activeMs + gap,
      };
      set({ session: next });

      if (options.onEvent) {
        // Starting over zeroes the clock, so the time on the idea being left is read before that.
        const derived = deriveEvents(
          before,
          action.type === "restart" ? { ...next, activeMs: before.activeMs + gap } : next,
          openView,
          eventContext(),
        );
        openView = derived.view;
        for (const event of derived.events) options.onEvent(event);
      }
    },

    suspend() {
      if (suspended) return;
      const time = now();
      const { session } = get();
      const gap =
        lastActionAt === null ? 0 : Math.min(Math.max(time - lastActionAt, 0), MAX_ACTIVE_GAP_MS);
      suspended = true;
      lastActionAt = null;
      if (gap > 0) set({ session: { ...session, activeMs: session.activeMs + gap } });
      // Report the idea being read so far, so a closed tab does not lose it.
      if (options.onEvent && openView) {
        const { activeMs } = get().session;
        options.onEvent({
          lessonId: session.lessonId,
          graphVersion: session.graphVersion,
          type: "concept_viewed",
          conceptId: openView.conceptId,
          durationMs: Math.max(Math.round(activeMs - openView.activeAtStart), 0),
        });
        openView = null;
      }
    },

    resume() {
      if (!suspended) return;
      suspended = false;
      lastActionAt = now(); // time away is not study
      const { session } = get();
      const id = context().conceptIds[session.conceptIndex];
      if (options.onEvent && session.phase === "learning" && id && !openView) {
        openView = { conceptId: id, activeAtStart: session.activeMs };
      }
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
      const session = saved ? restoreSession(saved, fresh(), context()) : get().session;
      set({ hydrated: true, session });
      // Coming back to an idea mid-lesson starts a view of it; nothing is reported for the one before.
      const ids = context().conceptIds;
      openView =
        session.phase === "learning" && ids[session.conceptIndex]
          ? { conceptId: ids[session.conceptIndex], activeAtStart: session.activeMs }
          : null;
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
