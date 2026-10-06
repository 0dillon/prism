import { splitSentences } from "@/lib/speech/sentences";
import type { TtsErrorCode, TtsProvider } from "@/lib/speech/tts";

/**
 * Speaks text one sentence at a time, and can take text as it arrives from a streaming
 * reply (PRD 5.6.3). The first sentence is spoken while the rest is still being written.
 * Only one thing is spoken at a time; starting another cancels the first, which is also
 * how barge-in works: `cancel()` stops the voice at once.
 */

export interface SpokenUtterance {
  /** Adds more text. Sentences that are complete are queued; the last may still be growing. */
  push(text: string): void;
  /** Says no more text is coming. */
  end(): void;
  /** Resolves true if everything was spoken, false if it was cancelled or speech failed. */
  finished: Promise<boolean>;
}

export interface SpeechQueue {
  /** Starts a new utterance, cancelling any that is being spoken. */
  begin(): SpokenUtterance;
  /** Speaks a finished piece of text. */
  say(text: string): Promise<boolean>;
  /** Stops speaking now. */
  cancel(): void;
  readonly speaking: boolean;
}

export function createSpeechQueue(options: {
  tts: TtsProvider;
  getRate: () => number;
  language?: string;
  onError?: (code: TtsErrorCode) => void;
}): SpeechQueue {
  const { tts } = options;
  let current: { cancel: () => void } | null = null;
  let speaking = false;

  const queue: SpeechQueue = {
    get speaking() {
      return speaking;
    },

    cancel() {
      current?.cancel();
    },

    say(text) {
      const utterance = queue.begin();
      utterance.push(text);
      utterance.end();
      return utterance.finished;
    },

    begin() {
      current?.cancel();

      const waiting: string[] = [];
      let pending = "";
      let ended = false;
      let cancelled = false;
      let busy = false;
      let settle!: (spoken: boolean) => void;
      const finished = new Promise<boolean>((resolve) => (settle = resolve));
      let settled = false;
      const finish = (spoken: boolean) => {
        if (settled) return;
        settled = true;
        if (current === handle) {
          current = null;
          speaking = false;
        }
        settle(spoken);
      };

      const drain = () => {
        if (cancelled || busy) return;
        const next = waiting.shift();
        if (next === undefined) {
          if (ended) finish(true);
          return;
        }
        busy = true;
        speaking = true;
        tts.speak(
          next,
          {
            onEnd: () => {
              busy = false;
              drain();
            },
            onError: (code) => {
              cancelled = true;
              options.onError?.(code);
              finish(false);
            },
          },
          { rate: options.getRate(), language: options.language },
        );
      };

      const handle = {
        cancel() {
          if (settled) return;
          cancelled = true;
          tts.cancel();
          finish(false);
        },
      };
      current = handle;

      return {
        finished,
        push(text) {
          if (cancelled || ended) return;
          pending += text;
          const sentences = splitSentences(pending);
          if (sentences.length > 1) {
            // Everything but the last sentence is complete; the last may still be growing.
            const keepFrom = sentences[sentences.length - 1].start;
            for (const sentence of sentences.slice(0, -1)) waiting.push(sentence.text);
            pending = pending.slice(keepFrom);
            drain();
          }
        },
        end() {
          if (cancelled || ended) return;
          ended = true;
          for (const sentence of splitSentences(pending)) waiting.push(sentence.text);
          pending = "";
          drain();
        },
      };
    },
  };
  return queue;
}
