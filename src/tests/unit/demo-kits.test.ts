import { describe, expect, it } from "vitest";
import { createDemoKits } from "@/lib/demo/kits";
import { DEMO_LEARNERS, namespacedStorage, type KeyValueStorage } from "@/lib/demo/learners";
import { presetProfile } from "@/lib/profile/presets";
import { STORAGE_KEY } from "@/lib/profile/store";

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("namespacedStorage", () => {
  it("keeps each prefix's keys apart", () => {
    const base = memory();
    const a = namespacedStorage(base, "a.");
    const b = namespacedStorage(base, "b.");
    a.setItem("k", "1");
    b.setItem("k", "2");
    expect(a.getItem("k")).toBe("1");
    expect(b.getItem("k")).toBe("2");
    expect([...base.data.keys()].sort()).toEqual(["a.k", "b.k"]);
    a.removeItem("k");
    expect(a.getItem("k")).toBeNull();
    expect(b.getItem("k")).toBe("2");
  });
});

describe("demo learners", () => {
  it("are named by how they like to learn, and no label names a condition", () => {
    expect(DEMO_LEARNERS.map((l) => l.preset)).toEqual([
      "hyper_focus",
      "voice_native",
      "cognitive_ease",
      "visual_sign",
    ]);
    expect(JSON.stringify(DEMO_LEARNERS)).not.toMatch(/adhd|dyslex|autis|blind|deaf|disabilit/i);
  });

  it("have distinct ids", () => {
    expect(new Set(DEMO_LEARNERS.map((l) => l.id)).size).toBe(DEMO_LEARNERS.length);
  });
});

describe("createDemoKits", () => {
  it("starts each learner on their own preset and layout", () => {
    const kits = createDemoKits(memory());
    for (const learner of DEMO_LEARNERS) {
      const { profileStore } = kits.kitFor(learner.id);
      expect(profileStore.getState().profile).toEqual(presetProfile(learner.preset));
    }
    expect(kits.kitFor("maya").profileStore.getState().profile.layout).toBe("cards");
    expect(kits.kitFor("tunde").profileStore.getState().profile.layout).toBe("conversation");
    expect(kits.kitFor("leo").profileStore.getState().profile.layout).toBe("reader");
    expect(kits.kitFor("sofia").profileStore.getState().profile.layout).toBe("visual");
  });

  it("is hydrated at once, so the first thing drawn is the learner's own layout", () => {
    const { profileStore, sessionStore } = createDemoKits(memory()).kitFor("maya");
    expect(profileStore.getState().hydrated).toBe(true);
    expect(sessionStore.getState().hydrated).toBe(true);
  });

  it("returns the same kit for the same learner", () => {
    const kits = createDemoKits(memory());
    expect(kits.kitFor("maya")).toBe(kits.kitFor("maya"));
    expect(kits.kitFor("maya")).not.toBe(kits.kitFor("leo"));
  });

  it("keeps each learner's place apart from the others'", () => {
    const kits = createDemoKits(memory());
    kits.kitFor("maya").sessionStore.getState().start();
    kits.kitFor("maya").sessionStore.getState().next();
    expect(kits.kitFor("maya").sessionStore.getState().session).toMatchObject({
      phase: "learning",
      conceptIndex: 1,
    });
    expect(kits.kitFor("leo").sessionStore.getState().session.phase).toBe("intro");
  });

  it("keeps each learner's settings apart too", () => {
    const kits = createDemoKits(memory());
    kits
      .kitFor("maya")
      .profileStore.getState()
      .applyPatch({ typography: { sizeScale: 2 } });
    expect(kits.kitFor("leo").profileStore.getState().profile.typography.sizeScale).not.toBe(2);
  });

  it("brings a learner back to their place and settings after a reload", () => {
    const storage = memory();
    const first = createDemoKits(storage).kitFor("maya");
    first.sessionStore.getState().start();
    first.sessionStore.getState().next();
    first.profileStore.getState().applyPatch({ typography: { sizeScale: 1.75 } });

    const second = createDemoKits(storage).kitFor("maya");
    expect(second.sessionStore.getState().session.conceptIndex).toBe(1);
    expect(second.profileStore.getState().profile.typography.sizeScale).toBe(1.75);
  });

  it("does not overwrite saved settings with the preset when a learner returns", () => {
    const storage = memory();
    createDemoKits(storage)
      .kitFor("maya")
      .profileStore.getState()
      .applyPatch({ quiz: { cadence: 7 } });
    const again = createDemoKits(storage).kitFor("maya");
    expect(again.profileStore.getState().profile.quiz.cadence).toBe(7);
    expect(JSON.parse(storage.getItem(`prism.demo.maya.${STORAGE_KEY}`)!).quiz.cadence).toBe(7);
  });

  it("starts one learner over without touching another", () => {
    const storage = memory();
    const kits = createDemoKits(storage);
    kits.kitFor("maya").sessionStore.getState().start();
    kits
      .kitFor("maya")
      .profileStore.getState()
      .applyPatch({ typography: { sizeScale: 2 } });
    kits.kitFor("leo").sessionStore.getState().start();

    const fresh = kits.reset("maya");
    expect(fresh.sessionStore.getState().session.phase).toBe("intro");
    expect(fresh.profileStore.getState().profile).toEqual(presetProfile("hyper_focus"));
    expect(kits.kitFor("maya")).toBe(fresh);
    expect(kits.kitFor("leo").sessionStore.getState().session.phase).toBe("learning");

    // And it stays reset after a reload.
    const reloaded = createDemoKits(storage).kitFor("maya");
    expect(reloaded.sessionStore.getState().session.phase).toBe("intro");
    expect(reloaded.profileStore.getState().profile).toEqual(presetProfile("hyper_focus"));
  });

  it("falls back to the preset when what was saved is not a usable profile", () => {
    const storage = memory();
    storage.setItem(`prism.demo.sofia.${STORAGE_KEY}`, "{not json");
    expect(createDemoKits(storage).kitFor("sofia").profileStore.getState().profile).toEqual(
      presetProfile("visual_sign"),
    );
    storage.setItem(`prism.demo.leo.${STORAGE_KEY}`, JSON.stringify({ layout: "nonsense" }));
    expect(createDemoKits(storage).kitFor("leo").profileStore.getState().profile).toEqual(
      presetProfile("cognitive_ease"),
    );
  });

  it("does not leave an undo step for the starting preset", () => {
    const { profileStore } = createDemoKits(memory()).kitFor("maya");
    expect(profileStore.getState().history).toEqual([]);
    expect(profileStore.getState().undo()).toBe(false);
  });

  it("still works with no storage at all, such as a private window", () => {
    const kits = createDemoKits(null);
    const { profileStore, sessionStore } = kits.kitFor("tunde");
    expect(profileStore.getState().profile.layout).toBe("conversation");
    sessionStore.getState().start();
    expect(sessionStore.getState().session.phase).toBe("learning");
    expect(kits.reset("tunde").profileStore.getState().profile.layout).toBe("conversation");
  });

  it("copes with storage that throws, carrying on in memory", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const kits = createDemoKits(broken);
    const { profileStore, sessionStore } = kits.kitFor("maya");
    expect(profileStore.getState().profile.layout).toBe("cards");
    sessionStore.getState().start();
    expect(sessionStore.getState().session.phase).toBe("learning");
    expect(() => kits.reset("maya")).not.toThrow();
  });
});
