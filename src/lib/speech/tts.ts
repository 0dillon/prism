/**
 * Text to speech (PRD 5.6, 7.2). One interface, several providers: the browser's
 * `speechSynthesis` is the MVP path and the fallback, and a streaming provider with word
 * timings replaces it in production (P4-24). Callers depend only on this interface.
 *
 * It speaks one piece of text at a time. Longer material is read as a queue of sentences
 * by the caller, which is more reliable across browsers than one long utterance (some
 * engines stop after about fifteen seconds) and gives a natural place to highlight.
 */

export type TtsErrorCode = "not_supported" | "blocked" | "unknown";

export interface TtsBoundary {
  /** Where the engine has reached, as an index into the text that was spoken. */
  charIndex: number;
  /** The length of the word or sentence just started, when the engine says. */
  charLength?: number;
  kind: "word" | "sentence";
}

export interface TtsHandlers {
  onStart?(): void;
  /** Progress through the text. Not every voice or engine sends these. */
  onBoundary?(boundary: TtsBoundary): void;
  /** The text was spoken to the end. Not called after `cancel()`. */
  onEnd(): void;
  /** Speech failed. Not called for a deliberate `cancel()`. */
  onError?(code: TtsErrorCode): void;
}

export interface TtsOptions {
  /** Speaking speed, 1 is normal. */
  rate?: number;
  /** A BCP 47 language tag, for example "en-US". */
  language?: string;
}

export interface TtsProvider {
  /** Whether this provider can work in the current browser. */
  readonly supported: boolean;
  /** Speaks the text, stopping anything already being spoken. */
  speak(text: string, handlers: TtsHandlers, options?: TtsOptions): void;
  /** Stops speaking at once and drops the callbacks for what was being spoken. */
  cancel(): void;
}

export const TTS_ERROR_MESSAGES: Record<TtsErrorCode, string> = {
  not_supported: "Reading aloud is not available in this browser. You can read the text on screen.",
  blocked: "Your browser stopped Prism from speaking. Press Play again to start.",
  unknown: "Something went wrong while reading aloud. You can read the text on screen.",
};

export const MIN_RATE = 0.5;
export const MAX_RATE = 3;

/** Keeps a rate inside what the settings allow, and falls back to normal speed for nonsense. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(Math.max(rate, MIN_RATE), MAX_RATE);
}
