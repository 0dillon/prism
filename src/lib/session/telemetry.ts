import type { StoreApi } from "zustand/vanilla";
import type { ProfileStore } from "@/lib/profile/store";
import type { LessonSession } from "./machine";
import type { TrackInput } from "./events";

/**
 * Which learning events a change in the lesson produces (PRD 5.7, P5-03). It looks only at
 * the session before and after an action, never at a renderer, so every layout reports the
 * same events for the same lesson: that is what lets progress be compared across layouts.
 *
 * - `lesson_started`: the learner begins.
 * - `concept_viewed`: one for each stretch spent on an idea, sent when they leave it, with
 *   the active time on it.
 * - `quiz_presented` and `quiz_answered`: each question, and its answer with the time taken.
 * - `lesson_completed`: the end, with the total active time.
 */

export interface EventContext {
  /** Concept ids in teaching order. */
  conceptIds: readonly string[];
  /** The concept each quiz item belongs to. */
  conceptOfItem: (itemId: string) => string | undefined;
}

/** The view of an idea that is currently open, so its time can be reported when it closes. */
export interface OpenView {
  conceptId: string;
  /** Active time (ms) when the view began. */
  activeAtStart: number;
}

export interface DerivedEvents {
  events: TrackInput[];
  /** The view that is open after this change, if any. */
  view: OpenView | null;
}

export function deriveEvents(
  before: LessonSession,
  after: LessonSession,
  openView: OpenView | null,
  context: EventContext,
): DerivedEvents {
  const base = { lessonId: after.lessonId, graphVersion: after.graphVersion };
  const events: TrackInput[] = [];
  let view = openView;

  if (before.phase === "intro" && after.phase !== "intro") {
    events.push({ ...base, type: "lesson_started" });
  }

  // A stretch on an idea ends when the learner moves to another idea or leaves the reading
  // screen (for a question, the end, or starting over), and a new one begins on arriving.
  const reading = after.phase === "learning" ? context.conceptIds[after.conceptIndex] : undefined;
  if (view && view.conceptId !== reading) {
    events.push({
      ...base,
      type: "concept_viewed",
      conceptId: view.conceptId,
      durationMs: Math.max(Math.round(after.activeMs - view.activeAtStart), 0),
    });
    view = null;
  }
  if (reading && !view) view = { conceptId: reading, activeAtStart: after.activeMs };

  // A question comes on screen.
  const item = after.activeQuizItemId;
  if (
    after.phase === "quiz" &&
    item &&
    (before.phase !== "quiz" || before.activeQuizItemId !== item)
  ) {
    events.push({
      ...base,
      type: "quiz_presented",
      quizItemId: item,
      conceptId: context.conceptOfItem(item),
    });
  }

  // An answer, with the active time since the question appeared.
  if (before.phase === "quiz" && after.phase === "feedback" && after.lastAnswer) {
    const { quizItemId, correct } = after.lastAnswer;
    events.push({
      ...base,
      type: "quiz_answered",
      quizItemId,
      conceptId: context.conceptOfItem(quizItemId),
      correct,
      durationMs: Math.max(Math.round(after.activeMs - before.activeMs), 0),
    });
  }

  if (before.phase !== "complete" && after.phase === "complete") {
    events.push({ ...base, type: "lesson_completed", durationMs: Math.round(after.activeMs) });
  }

  return { events, view };
}

/**
 * Reports each change to the learner's settings while they are in a lesson. Loading the
 * saved profile at the start is not a change and is not reported.
 */
export function trackProfileChanges(
  profileStore: StoreApi<ProfileStore>,
  options: { lessonId: string; graphVersion: number; track: (e: TrackInput) => void },
): () => void {
  return profileStore.subscribe((state, previous) => {
    if (state.profile === previous.profile || !previous.hydrated) return;
    options.track({
      type: "profile_changed",
      lessonId: options.lessonId,
      graphVersion: options.graphVersion,
    });
  });
}
