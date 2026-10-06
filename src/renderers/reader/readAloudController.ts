import { clampRate, type TtsErrorCode, type TtsProvider } from "@/lib/speech/tts";
import type { ScriptSentence } from "./content";

/**
 * Reads a list of sentences aloud one at a time (PRD 5.6.2): play, pause, skip, change the
 * speed, and tell the screen which sentence is being read. It owns no React state, so it is
 * easy to test, and it works with any TtsProvider.
 *
 * Pause stops the voice and remembers the sentence; resume reads that sentence again from
 * its start. That is more dependable than the browser's own pause, which many phones ignore.
 */

export type ReadAloudStatus = "idle" | "playing" | "paused";

export interface ReadAloudState {
  status: ReadAloudStatus;
  /** Position in the script. */
  index: number;
  total: number;
  /** The sentence being read, or the one paused on. Null when idle. */
  activeId: string | null;
  error: TtsErrorCode | null;
}

export interface ReadAloudController {
  load(script: readonly ScriptSentence[]): void;
  play(): void;
  pause(): void;
  toggle(): void;
  skip(): void;
  stop(): void;
  setRate(rate: number): void;
  getState(): ReadAloudState;
  subscribe(listener: (state: ReadAloudState) => void): () => void;
  /** Stops speaking and drops listeners. */
  dispose(): void;
}

export function createReadAloudController(options: {
  tts: TtsProvider;
  rate?: number;
  language?: string;
  /** Called once when the last sentence has been read. */
  onFinished?: () => void;
}): ReadAloudController {
  const { tts } = options;
  let script: readonly ScriptSentence[] = [];
  let rate = clampRate(options.rate ?? 1);
  // Moves on whenever speech is stopped or restarted, so a late callback from an earlier
  // sentence cannot start the one after it.
  let run = 0;
  const listeners = new Set<(state: ReadAloudState) => void>();

  let state: ReadAloudState = { status: "idle", index: 0, total: 0, activeId: null, error: null };
  const set = (patch: Partial<ReadAloudState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };

  const halt = () => {
    run++;
    tts.cancel();
  };

  const finish = () => {
    run++;
    set({ status: "idle", index: 0, activeId: null });
    options.onFinished?.();
  };

  const speakAt = (index: number) => {
    if (index >= script.length) {
      finish();
      return;
    }
    const mine = ++run;
    set({ status: "playing", index, activeId: script[index].id, error: null });
    tts.speak(
      script[index].text,
      {
        onEnd: () => {
          if (run === mine) speakAt(index + 1);
        },
        onError: (code) => {
          if (run !== mine) return;
          // Stay on this sentence, so Play tries it again (for example after a tap the
          // browser wanted). With no speech at all there is nothing to go back to.
          run++;
          set({ status: code === "not_supported" ? "idle" : "paused", error: code });
        },
      },
      { rate, language: options.language },
    );
  };

  return {
    load(next) {
      halt();
      script = next;
      state = {
        status: "idle",
        index: 0,
        total: next.length,
        activeId: null,
        error: null,
      };
      for (const listener of listeners) listener(state);
    },

    play() {
      if (script.length === 0 || state.status === "playing") return;
      speakAt(state.status === "paused" ? state.index : 0);
    },

    pause() {
      if (state.status !== "playing") return;
      halt();
      set({ status: "paused" });
    },

    toggle() {
      if (state.status === "playing") this.pause();
      else this.play();
    },

    skip() {
      if (state.status === "playing") {
        speakAt(state.index + 1);
      } else if (state.status === "paused") {
        const next = state.index + 1;
        if (next >= script.length) {
          halt();
          finish();
        } else {
          set({ index: next, activeId: script[next].id });
        }
      }
    },

    stop() {
      halt();
      set({ status: "idle", index: 0, activeId: null, error: null });
    },

    setRate(next) {
      rate = clampRate(next);
      // Hear the new speed straight away, from the start of the sentence being read.
      if (state.status === "playing") speakAt(state.index);
    },

    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    dispose() {
      halt();
      listeners.clear();
    },
  };
}
