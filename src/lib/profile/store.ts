import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { useEffect } from "react";
import { RenderProfile, type Preset } from "@/lib/schemas/render-profile";
import {
  diffProfiles,
  deepMergeProfile,
  ProfilePatchError,
  type ProfileChange,
  type ProfilePatch,
} from "./merge";
import { saveProfileToServer } from "./client";
import { DEFAULT_PROFILE, presetProfile } from "./presets";

/**
 * The learner's Render Profile (PRD 5.5). One store holds the current profile; renderers
 * read it and never keep their own copy. Changing it is synchronous, so switching
 * layout or preset needs no network. Saving to the server happens afterwards, debounced,
 * in the background.
 */

export const STORAGE_KEY = "prism.profile.v1";
const MAX_HISTORY = 20;
const COALESCE_WINDOW_MS = 800;
const DEFAULT_DEBOUNCE_MS = 800;

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface ProfileState {
  profile: RenderProfile;
  /** Earlier profiles, newest last, so a change can be undone. */
  history: RenderProfile[];
  /** What the most recent change did, for the "undo" message. */
  lastChange: { changes: ProfileChange[]; explanation?: string } | null;
  saveStatus: SaveStatus;
  hydrated: boolean;
}

export interface ProfileActions {
  applyPreset(preset: Exclude<Preset, "custom">): void;
  /**
   * Merges a partial change. Throws ProfilePatchError and keeps the profile if it is invalid.
   * Changes that share a `coalesceKey` within a short window become one undo step, so
   * dragging a slider is undone in one go.
   */
  applyPatch(
    patch: ProfilePatch,
    options?: { explanation?: string; coalesceKey?: string },
  ): ProfileChange[];
  /** Replaces the profile with one that was already merged and validated, such as a server result. */
  applyProfile(next: RenderProfile, options?: { explanation?: string }): ProfileChange[];
  undo(): boolean;
  /** Replaces the profile without recording history, for loading one from the server. */
  setProfile(profile: RenderProfile): void;
  /** Reads the saved profile from storage. Call once on the client after mount. */
  hydrate(): void;
  /** Saves now instead of waiting for the debounce. */
  flush(): Promise<void>;
}

export type ProfileStore = ProfileState & ProfileActions;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ProfileStoreOptions {
  storage?: StorageLike | null;
  /** Saves the profile to the server. Rejects on failure. */
  save?: (profile: RenderProfile) => Promise<void>;
  debounceMs?: number;
}

/** localStorage can throw (private windows, blocked site data), so it is never trusted. */
function safeBrowserStorage(): StorageLike | null {
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

function readStored(storage: StorageLike | null): RenderProfile | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = RenderProfile.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createProfileStore(options: ProfileStoreOptions = {}): StoreApi<ProfileStore> {
  const storage = options.storage === undefined ? safeBrowserStorage() : options.storage;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastCoalesce: { key: string; at: number } | null = null;

  const store = createStore<ProfileStore>((set, get) => {
    const change = (
      next: RenderProfile,
      changes: ProfileChange[],
      explanation?: string,
      coalesceKey?: string,
    ) => {
      const { profile, history } = get();
      const time = Date.now();
      // A run of changes to the same control is one step to undo.
      const continuing =
        coalesceKey !== undefined &&
        lastCoalesce?.key === coalesceKey &&
        time - lastCoalesce.at < COALESCE_WINDOW_MS &&
        history.length > 0;
      lastCoalesce = coalesceKey === undefined ? null : { key: coalesceKey, at: time };
      set({
        profile: next,
        history: continuing ? history : [...history, profile].slice(-MAX_HISTORY),
        lastChange: { changes, explanation },
      });
    };

    return {
      profile: DEFAULT_PROFILE,
      history: [],
      lastChange: null,
      saveStatus: "idle",
      hydrated: false,

      applyPreset(preset) {
        const next = presetProfile(preset);
        const changes = diffProfiles(get().profile, next);
        if (changes.length === 0) return;
        change(next, changes);
      },

      applyPatch(patch, patchOptions) {
        const current = get().profile;
        const merged = deepMergeProfile(current, patch);
        // A patch that changes nothing is not a change, so it is not recorded or saved.
        if (diffProfiles(current, merged).length === 0) return [];
        // Adjusting individual settings makes the profile the learner's own.
        const next =
          patch.preset === undefined && merged.preset !== "custom"
            ? { ...merged, preset: "custom" as const }
            : merged;
        const changes = diffProfiles(current, next);
        change(next, changes, patchOptions?.explanation, patchOptions?.coalesceKey);
        return changes;
      },

      applyProfile(next, profileOptions) {
        const parsed = RenderProfile.parse(next);
        const changes = diffProfiles(get().profile, parsed);
        if (changes.length === 0) return [];
        change(parsed, changes, profileOptions?.explanation);
        return changes;
      },

      undo() {
        const { history } = get();
        if (history.length === 0) return false;
        const previous = history[history.length - 1];
        lastCoalesce = null;
        set({ profile: previous, history: history.slice(0, -1), lastChange: null });
        return true;
      },

      setProfile(profile) {
        lastCoalesce = null;
        set({ profile, history: [], lastChange: null });
      },

      hydrate() {
        const stored = readStored(storage);
        set({ hydrated: true, ...(stored ? { profile: stored } : {}) });
      },

      async flush() {
        if (timer) clearTimeout(timer);
        timer = null;
        const save = options.save;
        if (!save) return;
        set({ saveStatus: "saving" });
        try {
          await save(get().profile);
          set({ saveStatus: "saved" });
        } catch {
          set({ saveStatus: "error" });
        }
      },
    };
  });

  // Whenever the profile changes: remember it locally, then save it in the background.
  store.subscribe((state, previous) => {
    if (state.profile === previous.profile) return;
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(state.profile));
    } catch {
      // Ignore: see above.
    }
    if (!options.save || !state.hydrated) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void store.getState().flush(), debounceMs);
  });

  return store;
}

export { ProfilePatchError };

// The app's store. Created lazily so server rendering never touches the browser.
let appStore: StoreApi<ProfileStore> | null = null;

export function getProfileStore(options?: ProfileStoreOptions): StoreApi<ProfileStore> {
  // The app's store saves to the server in the background. Signed-out visitors keep it on the device.
  appStore ??= createProfileStore(options ?? { save: saveProfileToServer });
  return appStore;
}

/** Test hook: forget the shared store. */
export function resetProfileStoreForTests(): void {
  appStore = null;
}

export function useProfile<T>(selector: (state: ProfileStore) => T, store = getProfileStore()): T {
  return useStore(store, selector);
}

/** Loads the saved profile after the first render, so server and client markup match. */
export function useProfileHydration(store = getProfileStore()): void {
  useEffect(() => {
    if (!store.getState().hydrated) store.getState().hydrate();
  }, [store]);
}
