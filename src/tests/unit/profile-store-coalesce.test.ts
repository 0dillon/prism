import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROFILE } from "@/lib/profile/presets";
import { createProfileStore } from "@/lib/profile/store";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const size = (store: ReturnType<typeof createProfileStore>, value: number) =>
  store.getState().applyPatch({ typography: { sizeScale: value } }, { coalesceKey: "size" });

describe("profile store: undo steps for a run of changes", () => {
  it("makes a quick run on one control a single undo step", () => {
    const store = createProfileStore({ storage: null });
    size(store, 1.1);
    vi.advanceTimersByTime(100);
    size(store, 1.2);
    vi.advanceTimersByTime(100);
    size(store, 1.3);
    expect(store.getState().profile.typography.sizeScale).toBe(1.3);
    expect(store.getState().history).toHaveLength(1);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().profile).toEqual(DEFAULT_PROFILE);
  });

  it("starts a new step after a pause", () => {
    const store = createProfileStore({ storage: null });
    size(store, 1.1);
    vi.advanceTimersByTime(1000);
    size(store, 1.2);
    expect(store.getState().history).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().profile.typography.sizeScale).toBe(1.1);
  });

  it("keeps the window open while changes keep coming", () => {
    const store = createProfileStore({ storage: null });
    for (let i = 1; i <= 6; i++) {
      size(store, 1 + i / 10);
      vi.advanceTimersByTime(500);
    }
    expect(store.getState().history).toHaveLength(1);
  });

  it("keeps different controls as different steps", () => {
    const store = createProfileStore({ storage: null });
    size(store, 1.2);
    store.getState().applyPatch({ quiz: { cadence: 2 } }, { coalesceKey: "cadence" });
    expect(store.getState().history).toHaveLength(2);
  });

  it("never merges changes that have no key", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPatch({ quiz: { cadence: 2 } });
    store.getState().applyPatch({ quiz: { cadence: 3 } });
    expect(store.getState().history).toHaveLength(2);
  });

  it("does not merge a keyed change into a preset or other change before it", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPreset("hyper_focus");
    size(store, 1.2);
    expect(store.getState().history).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().profile.preset).toBe("hyper_focus");
  });

  it("starts fresh after an undo, so it cannot swallow an earlier step", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPatch({ quiz: { cadence: 2 } });
    size(store, 1.2);
    store.getState().undo();
    size(store, 1.4);
    expect(store.getState().history).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().profile.quiz.cadence).toBe(2);
    expect(store.getState().profile.typography.sizeScale).toBe(1);
  });

  it("does not record a step for a value that did not change", () => {
    const store = createProfileStore({ storage: null });
    expect(size(store, 1)).toEqual([]);
    expect(store.getState().history).toEqual([]);
  });

  it("saves the latest value once after a run of changes", () => {
    const save = vi.fn(async () => {});
    const store = createProfileStore({ storage: null, save, debounceMs: 100 });
    store.getState().hydrate();
    size(store, 1.1);
    size(store, 1.2);
    vi.advanceTimersByTime(150);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual([
      expect.objectContaining({ typography: expect.objectContaining({ sizeScale: 1.2 }) }),
    ]);
  });
});
