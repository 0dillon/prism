import type { StoreApi } from "zustand/vanilla";
import { RenderProfile } from "@/lib/schemas/render-profile";
import { presetProfile } from "@/lib/profile/presets";
import {
  createProfileStore,
  STORAGE_KEY as PROFILE_KEY,
  type ProfileStore,
} from "@/lib/profile/store";
import { createSessionStore, SESSION_STORAGE_PREFIX, type SessionStore } from "@/lib/session/store";
import {
  DEMO_LEARNERS,
  namespacedStorage,
  type DemoLearner,
  type DemoLearnerId,
  type KeyValueStorage,
} from "./learners";
import { SAMPLE_GRAPH_VERSION, SAMPLE_LESSON, SAMPLE_LESSON_ID } from "./sample-lesson";

/**
 * Everything one demo learner owns: their settings and their place in the lesson. Each
 * learner has their own profile store and session store, saved under their own keys, so
 * switching learner swaps both and switching back finds them where they were (PRD P9-03).
 */
export interface LearnerKit {
  learner: DemoLearner;
  profileStore: StoreApi<ProfileStore>;
  sessionStore: StoreApi<SessionStore>;
}

export interface DemoKits {
  /** The learner's kit, made on first use and the same one every time after. */
  kitFor(id: DemoLearnerId): LearnerKit;
  /** Forgets the learner's saved settings and place, and starts them from their preset again. */
  reset(id: DemoLearnerId): LearnerKit;
}

const storagePrefix = (id: string) => `prism.demo.${id}.`;

function hasSavedProfile(storage: KeyValueStorage | null): boolean {
  try {
    const raw = storage?.getItem(PROFILE_KEY);
    return raw ? RenderProfile.safeParse(JSON.parse(raw)).success : false;
  } catch {
    return false;
  }
}

function buildKit(learner: DemoLearner, base: KeyValueStorage | null): LearnerKit {
  const storage = base ? namespacedStorage(base, storagePrefix(learner.id)) : null;

  // A learner who has never been here starts from their preset. One who has comes back to
  // their saved settings. The preset is set in memory after loading rather than written to
  // storage first, so it still applies when storage is unavailable or holds something unusable.
  const hadSaved = hasSavedProfile(storage);
  const profileStore = createProfileStore({ storage });
  profileStore.getState().hydrate();
  if (!hadSaved) profileStore.getState().setProfile(presetProfile(learner.preset));

  const sessionStore = createSessionStore({
    lessonId: SAMPLE_LESSON_ID,
    graphVersion: SAMPLE_GRAPH_VERSION,
    graph: SAMPLE_LESSON,
    getSettings: () => {
      const { quiz } = profileStore.getState().profile;
      return {
        cadence: quiz.cadence,
        itemsPerCheck: quiz.itemsPerCheck,
        retryOnWrong: quiz.retryOnWrong,
      };
    },
    storage,
  });
  sessionStore.getState().hydrate();

  return { learner, profileStore, sessionStore };
}

export function createDemoKits(base: KeyValueStorage | null): DemoKits {
  const kits = new Map<DemoLearnerId, LearnerKit>();
  const learnerOf = (id: DemoLearnerId) => {
    const learner = DEMO_LEARNERS.find((l) => l.id === id);
    if (!learner) throw new Error(`Unknown demo learner: ${id}`);
    return learner;
  };

  return {
    kitFor(id) {
      let kit = kits.get(id);
      if (!kit) {
        kit = buildKit(learnerOf(id), base);
        kits.set(id, kit);
      }
      return kit;
    },
    reset(id) {
      const learner = learnerOf(id);
      try {
        base?.removeItem(storagePrefix(id) + PROFILE_KEY);
        base?.removeItem(`${storagePrefix(id)}${SESSION_STORAGE_PREFIX}${SAMPLE_LESSON_ID}`);
      } catch {
        // Storage trouble only means the old state may come back after a reload.
      }
      const kit = buildKit(learner, base);
      kits.set(id, kit);
      return kit;
    },
  };
}

/** The browser's localStorage if it works, or null (private windows, blocked site data). */
export function browserStorageOrNull(): KeyValueStorage | null {
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
