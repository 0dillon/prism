import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackInput } from "@/lib/session/events";
import { createSessionStore, MAX_ACTIVE_GAP_MS } from "@/lib/session/store";
import { makeGraph } from "../fixtures/graph";

const graph = makeGraph();

/** Uses the real clock, which fake timers control, so these read like a learner's afternoon. */
function make() {
  const events: TrackInput[] = [];
  const store = createSessionStore({
    lessonId: graph.lessonId,
    graphVersion: 1,
    graph,
    getSettings: () => ({ cadence: 5, itemsPerCheck: 1, retryOnWrong: false }),
    storage: null,
    onEvent: (e) => events.push(e),
  });
  const active = () => store.getState().session.activeMs;
  const views = () => events.filter((e) => e.type === "concept_viewed");
  return { store, events, active, views };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T09:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("active time (P5-04)", () => {
  it("counts time spent working between actions", () => {
    const { store, active } = make();
    store.getState().start();
    vi.advanceTimersByTime(25_000);
    store.getState().next();
    expect(active()).toBe(25_000);
  });

  it("leaves out idle time: a gap over 60 seconds counts for only 60", () => {
    const { store, active, views } = make();
    store.getState().start();
    vi.advanceTimersByTime(10 * 60_000); // ten minutes of nothing
    store.getState().next();
    expect(active()).toBe(MAX_ACTIVE_GAP_MS);
    expect(views()[0].durationMs).toBe(MAX_ACTIVE_GAP_MS);
  });

  it("stops counting while the tab is hidden, and starts again when it is back", () => {
    const { store, active } = make();
    store.getState().start();
    vi.advanceTimersByTime(20_000);
    store.getState().suspend();
    vi.advanceTimersByTime(30 * 60_000); // away for half an hour
    store.getState().resume();
    vi.advanceTimersByTime(15_000);
    store.getState().next();
    expect(active()).toBe(35_000);
  });

  it("counts the time up to the moment the tab was hidden, even with no action then", () => {
    const { store, active } = make();
    store.getState().start();
    vi.advanceTimersByTime(40_000);
    store.getState().suspend();
    expect(active()).toBe(40_000);
  });

  it("caps the stretch before hiding too, since the learner may have been idle", () => {
    const { store, active } = make();
    store.getState().start();
    vi.advanceTimersByTime(5 * 60_000);
    store.getState().suspend();
    expect(active()).toBe(MAX_ACTIVE_GAP_MS);
  });

  it("reports the idea being read when the tab is hidden, so closing it loses nothing", () => {
    const { store, views } = make();
    store.getState().start();
    vi.advanceTimersByTime(12_000);
    store.getState().suspend();
    expect(views()).toEqual([
      expect.objectContaining({ conceptId: "c_evaporation", durationMs: 12_000 }),
    ]);
  });

  it("starts a new view of the same idea on return, and reports only the time since", () => {
    const { store, views } = make();
    store.getState().start();
    vi.advanceTimersByTime(12_000);
    store.getState().suspend();
    vi.advanceTimersByTime(10 * 60_000);
    store.getState().resume();
    vi.advanceTimersByTime(8_000);
    store.getState().next();
    expect(views().map((v) => [v.conceptId, v.durationMs])).toEqual([
      ["c_evaporation", 12_000],
      ["c_evaporation", 8_000],
    ]);
  });

  it("does nothing if suspended twice or resumed without being suspended", () => {
    const { store, active, views } = make();
    store.getState().start();
    store.getState().resume();
    vi.advanceTimersByTime(5_000);
    store.getState().suspend();
    store.getState().suspend();
    store.getState().resume();
    store.getState().resume();
    expect(active()).toBe(5_000);
    expect(views()).toHaveLength(1);
  });

  it("reports nothing on hide before the lesson has started or while answering a question", () => {
    const { store, views } = make();
    store.getState().suspend();
    store.getState().resume();
    expect(views()).toEqual([]);
    store.getState().start();
    store.getState().requestQuiz();
    const before = views().length;
    store.getState().suspend();
    expect(views()).toHaveLength(before);
  });

  it("opens no view on return when the learner was not reading", () => {
    const { store, views } = make();
    store.getState().start();
    store.getState().requestQuiz();
    store.getState().suspend();
    store.getState().resume();
    vi.advanceTimersByTime(3_000);
    store.getState().answer(store.getState().session.activeQuizItemId!, true);
    expect(views().map((v) => v.conceptId)).toEqual(["c_evaporation"]);
  });

  it("counts time on a question towards its answer, and not time away", () => {
    const { store, events } = make();
    store.getState().start();
    store.getState().requestQuiz();
    vi.advanceTimersByTime(9_000);
    store.getState().answer(store.getState().session.activeQuizItemId!, true);
    expect(events.find((e) => e.type === "quiz_answered")?.durationMs).toBe(9_000);
  });

  it("does not let an action while hidden count the time away", () => {
    const { store, active } = make();
    store.getState().start();
    store.getState().suspend();
    vi.advanceTimersByTime(20 * 60_000);
    store.getState().next(); // such as a voice command with the tab in the background
    expect(active()).toBe(0);
  });
});
