import type { Preset } from "@/lib/schemas/render-profile";

/**
 * The learners in the demo (PRD P9-03). Each starts from a preset. They are described by
 * how they like to learn, never by a condition: the presets are open to anyone, and the
 * demo should show that.
 */
export const DEMO_LEARNERS = [
  { id: "maya", name: "Maya", preset: "hyper_focus" },
  { id: "tunde", name: "Tunde", preset: "voice_native" },
  { id: "leo", name: "Leo", preset: "cognitive_ease" },
  { id: "sofia", name: "Sofia", preset: "visual_sign" },
] as const satisfies ReadonlyArray<{ id: string; name: string; preset: Exclude<Preset, "custom"> }>;

export type DemoLearner = (typeof DEMO_LEARNERS)[number];
export type DemoLearnerId = DemoLearner["id"];

/** Wraps a storage so each learner's saved profile and place sit under their own keys. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function namespacedStorage(base: KeyValueStorage, prefix: string): KeyValueStorage {
  // Storage can throw (full, or blocked after the page loaded), and the demo must carry on
  // without it: a failed read is "nothing saved" and a failed write is simply not saved.
  const safely = <T>(action: () => T, fallback: T): T => {
    try {
      return action();
    } catch {
      return fallback;
    }
  };
  return {
    getItem: (key) => safely(() => base.getItem(prefix + key), null),
    setItem: (key, value) => safely(() => base.setItem(prefix + key, value), undefined),
    removeItem: (key) => safely(() => base.removeItem(prefix + key), undefined),
  };
}
