/**
 * Speech to text (PRD 5.6.3, 7.2). One interface, several providers: the browser's Web
 * Speech API is the MVP path and the fallback, and a streaming provider with word
 * timestamps replaces it in production (P4-24). Callers depend only on this interface.
 *
 * Privacy note: some browsers send microphone audio to their own speech service when the
 * Web Speech API is used. Prism never stores audio; it only keeps the resulting text.
 */

export type SttErrorCode =
  | "not_supported"
  | "permission_denied"
  | "no_speech"
  | "no_microphone"
  | "network"
  | "aborted"
  | "unknown";

export interface SttHandlers {
  /** Interim text while the learner is still speaking. */
  onPartial(text: string): void;
  /** The finished transcript for one utterance. */
  onFinal(text: string): void;
  onError(code: SttErrorCode): void;
  /** Always called once when listening stops, after any final or error callback. */
  onEnd(): void;
}

export interface SttProvider {
  /** Whether this provider can work in the current browser. */
  readonly supported: boolean;
  /** Starts listening for one utterance. Does nothing if already listening. */
  start(handlers: SttHandlers, options?: { language?: string }): void;
  /** Stops listening and delivers what was heard so far. */
  stop(): void;
  /** Stops listening and discards what was heard. */
  abort(): void;
}

/** What to tell a learner for each error, in words that suggest the next step. */
export const STT_ERROR_MESSAGES: Record<SttErrorCode, string> = {
  not_supported: "Speaking is not available in this browser. You can type instead.",
  permission_denied:
    "Prism cannot use your microphone. Allow microphone access in your browser, or type instead.",
  no_speech: "I did not hear anything. Try again, or type instead.",
  no_microphone: "No microphone was found. You can type instead.",
  network: "Speech recognition could not connect. Check your connection, or type instead.",
  aborted: "Listening was stopped.",
  unknown: "Something went wrong while listening. You can type instead.",
};
