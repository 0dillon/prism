import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfilePatchError } from "@/lib/profile/merge";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { DEFAULT_PROFILE, presetProfile } from "@/lib/profile/presets";
import { createProfileStore, STORAGE_KEY, type StorageLike } from "@/lib/profile/store";

function memoryStorage(
  initial: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("profile store: changing the profile", () => {
  it("starts on the standard profile", () => {
    const store = createProfileStore({ storage: null });
    expect(store.getState().profile).toEqual(DEFAULT_PROFILE);
    expect(store.getState().history).toEqual([]);
  });

  it("applies a preset in full, synchronously", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPreset("hyper_focus");
    expect(store.getState().profile).toEqual(presetProfile("hyper_focus"));
    expect(store.getState().profile.layout).toBe("cards");
  });

  it("does nothing when the preset is already applied", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPreset("standard");
    expect(store.getState().history).toEqual([]);
    expect(store.getState().lastChange).toBeNull();
  });

  it("merges a patch and marks the profile as custom", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPreset("hyper_focus");
    const changes = store.getState().applyPatch({ quiz: { cadence: 2 } });
    expect(store.getState().profile.quiz.cadence).toBe(2);
    expect(store.getState().profile.preset).toBe("custom");
    expect(store.getState().profile.layout).toBe("cards");
    expect(changes.map((c) => c.path)).toEqual(["preset", "quiz.cadence"]);
  });

  it("keeps the preset name when the patch names one", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPatch({ preset: "voice_native", layout: "conversation" });
    expect(store.getState().profile.preset).toBe("voice_native");
  });

  it("treats a patch that changes nothing as no change", () => {
    const store = createProfileStore({ storage: null });
    expect(store.getState().applyPatch({ quiz: { cadence: 5 } })).toEqual([]);
    expect(store.getState().profile.preset).toBe("standard");
    expect(store.getState().history).toEqual([]);
  });

  it("rejects an invalid patch and keeps the profile", () => {
    const store = createProfileStore({ storage: null });
    const before = store.getState().profile;
    expect(() => store.getState().applyPatch({ quiz: { cadence: 99 } })).toThrow(ProfilePatchError);
    expect(() => store.getState().applyPatch({ nope: 1 } as never)).toThrow(ProfilePatchError);
    expect(store.getState().profile).toBe(before);
    expect(store.getState().history).toEqual([]);
  });

  it("records the explanation with the last change", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPatch({ layout: "cards" }, { explanation: "I switched to cards." });
    expect(store.getState().lastChange?.explanation).toBe("I switched to cards.");
    expect(store.getState().lastChange?.changes.some((c) => c.path === "layout")).toBe(true);
  });

  it("never lets one change affect the stored object of an earlier one", () => {
    const store = createProfileStore({ storage: null });
    const first = store.getState().profile;
    store.getState().applyPatch({ quiz: { cadence: 2 } });
    expect(first.quiz.cadence).toBe(5);
  });
});

describe("profile store: undo", () => {
  it("reverts the last change", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPreset("hyper_focus");
    store.getState().applyPatch({ quiz: { cadence: 2 } });
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().profile).toEqual(presetProfile("hyper_focus"));
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().profile).toEqual(DEFAULT_PROFILE);
  });

  it("returns false with nothing to undo", () => {
    expect(createProfileStore({ storage: null }).getState().undo()).toBe(false);
  });

  it("keeps at most 20 steps", () => {
    const store = createProfileStore({ storage: null });
    for (let i = 0; i < 30; i++)
      store.getState().applyPatch({ typography: { sizeScale: 1 + i / 100 } });
    expect(store.getState().history).toHaveLength(20);
  });

  it("clears the last change message after an undo", () => {
    const store = createProfileStore({ storage: null });
    store.getState().applyPatch({ layout: "cards" });
    store.getState().undo();
    expect(store.getState().lastChange).toBeNull();
  });
});

describe("profile store: local persistence", () => {
  it("remembers the profile, and a reload restores it", () => {
    const storage = memoryStorage();
    const first = createProfileStore({ storage });
    first.getState().hydrate();
    first.getState().applyPreset("cognitive_ease");
    first.getState().applyPatch({ typography: { sizeScale: 1.4 } });

    const reloaded = createProfileStore({ storage });
    expect(reloaded.getState().profile).toEqual(DEFAULT_PROFILE); // before hydration
    reloaded.getState().hydrate();
    expect(reloaded.getState().profile.typography.sizeScale).toBe(1.4);
    expect(reloaded.getState().profile.typography.font).toBe("lexend");
    expect(reloaded.getState().hydrated).toBe(true);
  });

  it("undo works after a reload only for changes made since", () => {
    const storage = memoryStorage();
    const first = createProfileStore({ storage });
    first.getState().applyPreset("hyper_focus");
    const reloaded = createProfileStore({ storage });
    reloaded.getState().hydrate();
    reloaded.getState().applyPatch({ quiz: { cadence: 2 } });
    reloaded.getState().undo();
    expect(reloaded.getState().profile).toEqual(presetProfile("hyper_focus"));
  });

  it.each([
    ["not json", "{nope"],
    ["the wrong shape", JSON.stringify({ layout: "cards" })],
    [
      "an invalid value",
      JSON.stringify({ ...DEFAULT_PROFILE, quiz: { ...DEFAULT_PROFILE.quiz, cadence: 99 } }),
    ],
  ])("ignores stored data that is %s", (_name, stored) => {
    const store = createProfileStore({ storage: memoryStorage({ [STORAGE_KEY]: stored }) });
    store.getState().hydrate();
    expect(store.getState().profile).toEqual(DEFAULT_PROFILE);
  });

  it("works when storage is unavailable", () => {
    const store = createProfileStore({ storage: null });
    store.getState().hydrate();
    store.getState().applyPreset("voice_native");
    expect(store.getState().profile.layout).toBe("conversation");
  });

  it("keeps working when storage throws", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    const store = createProfileStore({ storage: throwing });
    store.getState().hydrate();
    store.getState().applyPreset("hyper_focus");
    expect(store.getState().profile.layout).toBe("cards");
  });

  it("stores only the profile, with no history or status", () => {
    const storage = memoryStorage();
    const store = createProfileStore({ storage });
    store.getState().applyPreset("hyper_focus");
    const stored = JSON.parse(storage.data.get(STORAGE_KEY) as string);
    expect(Object.keys(stored).sort()).toEqual(
      [
        "audio",
        "content",
        "feedback",
        "layout",
        "preset",
        "quiz",
        "schemaVersion",
        "typography",
        "visual",
      ].sort(),
    );
  });

  it("never stores anything that looks like a diagnosis", () => {
    const storage = memoryStorage();
    const store = createProfileStore({ storage });
    store.getState().applyPreset("cognitive_ease");
    expect(storage.data.get(STORAGE_KEY)).not.toMatch(/adhd|dyslex|autis|diagnos|disab/i);
  });
});

describe("profile store: saving to the server", () => {
  it("saves once after changes settle, not on every change", async () => {
    const save = vi.fn<(profile: RenderProfile) => Promise<void>>(async () => {});
    const store = createProfileStore({ storage: null, save, debounceMs: 800 });
    store.getState().hydrate();
    store.getState().applyPatch({ quiz: { cadence: 2 } });
    store.getState().applyPatch({ quiz: { cadence: 3 } });
    store.getState().applyPatch({ quiz: { cadence: 4 } });
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(vi.mocked(save).mock.calls[0][0].quiz.cadence).toBe(4);
    expect(store.getState().saveStatus).toBe("saved");
  });

  it("does not wait for the network to change the profile", () => {
    const save = vi.fn(() => new Promise<void>(() => {}));
    const store = createProfileStore({ storage: null, save });
    store.getState().hydrate();
    store.getState().applyPreset("hyper_focus");
    expect(store.getState().profile.layout).toBe("cards"); // already applied
    expect(save).not.toHaveBeenCalled(); // nothing is sent synchronously
  });

  it("does not save before the stored profile has been loaded", async () => {
    const save = vi.fn<(profile: RenderProfile) => Promise<void>>(async () => {});
    const store = createProfileStore({ storage: null, save });
    store.getState().applyPreset("hyper_focus"); // before hydrate()
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).not.toHaveBeenCalled();
  });

  it("flush saves immediately", async () => {
    const save = vi.fn<(profile: RenderProfile) => Promise<void>>(async () => {});
    const store = createProfileStore({ storage: null, save });
    store.getState().hydrate();
    store.getState().applyPreset("hyper_focus");
    await store.getState().flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1); // the pending debounce was cancelled
  });

  it("marks a failed save and keeps the local change", async () => {
    const save = vi.fn(async () => {
      throw new Error("offline");
    });
    const store = createProfileStore({ storage: null, save });
    store.getState().hydrate();
    store.getState().applyPreset("hyper_focus");
    await store.getState().flush();
    expect(store.getState().saveStatus).toBe("error");
    expect(store.getState().profile.layout).toBe("cards");
  });

  it("saves the reverted profile after an undo", async () => {
    const save = vi.fn<(profile: RenderProfile) => Promise<void>>(async () => {});
    const store = createProfileStore({ storage: null, save });
    store.getState().hydrate();
    store.getState().applyPreset("hyper_focus");
    await store.getState().flush();
    store.getState().undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.mocked(save).mock.calls.at(-1)?.[0].layout).toBe("reader");
  });

  it("does nothing without a save function", async () => {
    const store = createProfileStore({ storage: null });
    await expect(store.getState().flush()).resolves.toBeUndefined();
    expect(store.getState().saveStatus).toBe("idle");
  });
});
