import type { Earcon } from "./controller";

/**
 * Short sounds that mark a change of state (PRD 5.6.3, P4-22): listening has started, an
 * answer was right, an answer was not. They are an extra for learners who want them, off
 * unless `audio.earcons` is on, and the same information is always on screen in words.
 * Each is a couple of quiet tones made with the Web Audio API, so there are no files.
 */

interface AudioLike {
  currentTime: number;
  destination: unknown;
  state?: string;
  resume?(): Promise<void>;
  createOscillator(): {
    frequency: { value: number };
    type: string;
    connect(node: unknown): void;
    start(at: number): void;
    stop(at: number): void;
  };
  createGain(): {
    gain: {
      value: number;
      setValueAtTime(v: number, t: number): void;
      exponentialRampToValueAtTime(v: number, t: number): void;
    };
    connect(node: unknown): void;
  };
}

/** Each tone: frequency in Hz and length in seconds. */
export const EARCON_TONES: Record<Earcon, ReadonlyArray<{ hz: number; seconds: number }>> = {
  listening: [
    { hz: 660, seconds: 0.08 },
    { hz: 880, seconds: 0.1 },
  ],
  correct: [
    { hz: 784, seconds: 0.09 },
    { hz: 1047, seconds: 0.16 },
  ],
  incorrect: [{ hz: 220, seconds: 0.22 }],
};

const VOLUME = 0.08;

export function createEarconPlayer(
  makeContext: () => AudioLike | null = defaultContext,
): (kind: Earcon) => void {
  let context: AudioLike | null | undefined;
  return (kind) => {
    try {
      if (context === undefined) context = makeContext();
      if (!context) return;
      if (context.state === "suspended") void context.resume?.();
      let at = context.currentTime;
      for (const { hz, seconds } of EARCON_TONES[kind]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = hz;
        gain.gain.setValueAtTime(VOLUME, at);
        // A quick fade, so each tone ends without a click.
        gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + seconds);
        at += seconds + 0.02;
      }
    } catch {
      // No sound is better than a broken lesson.
    }
  };
}

function defaultContext(): AudioLike | null {
  if (typeof window === "undefined") return null;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Context ? (new Context() as unknown as AudioLike) : null;
}
