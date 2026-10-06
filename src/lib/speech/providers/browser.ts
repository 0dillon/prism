import type { SttErrorCode, SttHandlers, SttProvider } from "../stt";
import { clampRate, type TtsHandlers, type TtsOptions, type TtsProvider } from "../tts";

/**
 * Speech to text through the browser's Web Speech API. Support varies by browser, so
 * `supported` is checked before the microphone button is offered, and every failure is
 * reported through the same error codes as any other provider.
 */

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

const ERROR_CODES: Record<string, SttErrorCode> = {
  "not-allowed": "permission_denied",
  "service-not-allowed": "permission_denied",
  "no-speech": "no_speech",
  "audio-capture": "no_microphone",
  network: "network",
  aborted: "aborted",
};

export function findRecognitionConstructor(
  scope: object | undefined = globalThis,
): RecognitionConstructor | null {
  const w = scope as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition ?? null;
}

export class BrowserStt implements SttProvider {
  private recognition: Recognition | null = null;
  private readonly Recognition: RecognitionConstructor | null;

  constructor(scope?: object) {
    this.Recognition = findRecognitionConstructor(scope);
  }

  get supported(): boolean {
    return this.Recognition !== null;
  }

  start(handlers: SttHandlers, options: { language?: string } = {}): void {
    if (this.recognition) return;
    if (!this.Recognition) {
      handlers.onError("not_supported");
      handlers.onEnd();
      return;
    }

    const recognition = new this.Recognition();
    recognition.lang = options.language ?? "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalText = "";
    let errored = false;
    let aborted = false;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      if (interim) handlers.onPartial((finalText + interim).trim());
    };

    recognition.onerror = (event) => {
      errored = true;
      const code = ERROR_CODES[event.error] ?? "unknown";
      // A deliberate abort is not a problem to report.
      if (code !== "aborted") handlers.onError(code);
    };

    recognition.onend = () => {
      this.recognition = null;
      const text = finalText.trim();
      if (!errored && !aborted && text) handlers.onFinal(text);
      else if (!errored && !aborted && !text) handlers.onError("no_speech");
      handlers.onEnd();
    };

    this.recognition = recognition;
    this.abortFlag = () => {
      aborted = true;
    };
    try {
      recognition.start();
    } catch {
      this.recognition = null;
      handlers.onError("unknown");
      handlers.onEnd();
    }
  }

  private abortFlag: (() => void) | null = null;

  stop(): void {
    this.recognition?.stop();
  }

  abort(): void {
    this.abortFlag?.();
    this.recognition?.abort();
  }
}

export function createBrowserStt(scope?: object): SttProvider {
  return new BrowserStt(scope);
}

// ---------------------------------------------------------------------------
// Text to speech through the browser's speechSynthesis.
// ---------------------------------------------------------------------------

interface BrowserUtterance {
  text: string;
  lang: string;
  rate: number;
  voice: BrowserVoice | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onboundary: ((event: { name?: string; charIndex: number; charLength?: number }) => void) | null;
}
interface BrowserVoice {
  lang: string;
  localService?: boolean;
  default?: boolean;
}
interface Synthesis {
  speak(utterance: BrowserUtterance): void;
  cancel(): void;
  getVoices(): BrowserVoice[];
}
type UtteranceConstructor = new (text: string) => BrowserUtterance;

/** Errors a browser reports for speech that was stopped on purpose, which are not failures. */
const DELIBERATE_STOPS = new Set(["canceled", "cancelled", "interrupted"]);

export class BrowserTts implements TtsProvider {
  private readonly synthesis: Synthesis | null;
  private readonly Utterance: UtteranceConstructor | null;
  // Each call to speak() or cancel() moves this on. Callbacks from an older utterance
  // check it first, so a stopped sentence can never report that it ended or failed.
  private token = 0;

  constructor(scope: object | undefined = globalThis) {
    const w = scope as {
      speechSynthesis?: Synthesis;
      SpeechSynthesisUtterance?: UtteranceConstructor;
    };
    this.synthesis = w?.speechSynthesis ?? null;
    this.Utterance = w?.SpeechSynthesisUtterance ?? null;
  }

  get supported(): boolean {
    return this.synthesis !== null && this.Utterance !== null;
  }

  speak(text: string, handlers: TtsHandlers, options: TtsOptions = {}): void {
    const { synthesis, Utterance } = this;
    if (!synthesis || !Utterance) {
      handlers.onError?.("not_supported");
      return;
    }
    const mine = ++this.token;
    synthesis.cancel();

    const utterance = new Utterance(text);
    const language = options.language ?? "en-US";
    utterance.lang = language;
    utterance.rate = clampRate(options.rate ?? 1);
    utterance.voice = this.pickVoice(language);

    const current = () => this.token === mine;
    utterance.onstart = () => {
      if (current()) handlers.onStart?.();
    };
    utterance.onboundary = (event) => {
      if (!current()) return;
      handlers.onBoundary?.({
        charIndex: event.charIndex,
        charLength: event.charLength,
        kind: event.name === "sentence" ? "sentence" : "word",
      });
    };
    utterance.onend = () => {
      if (current()) handlers.onEnd();
    };
    utterance.onerror = (event) => {
      if (!current()) return;
      const reason = event.error ?? "";
      if (DELIBERATE_STOPS.has(reason)) return;
      handlers.onError?.(reason === "not-allowed" ? "blocked" : "unknown");
    };

    try {
      synthesis.speak(utterance);
    } catch {
      if (current()) handlers.onError?.("unknown");
    }
  }

  cancel(): void {
    this.token++;
    try {
      this.synthesis?.cancel();
    } catch {
      // Nothing to stop.
    }
  }

  /**
   * A voice for the language. An exact match (en-GB for en-GB) comes first, then another
   * dialect of the same language, and within each a voice on this device is preferred, since
   * it is quicker, works offline and reliably reports where it is up to.
   */
  private pickVoice(language: string): BrowserVoice | null {
    let voices: BrowserVoice[] = [];
    try {
      voices = this.synthesis?.getVoices() ?? [];
    } catch {
      return null;
    }
    const wanted = language.toLowerCase();
    const base = wanted.split("-")[0];
    const sameLanguage = voices.filter((voice) => voice.lang?.toLowerCase().startsWith(base));
    const exact = sameLanguage.filter((voice) => voice.lang.toLowerCase() === wanted);
    const prefer = (list: BrowserVoice[]) => list.find((voice) => voice.localService) ?? list[0];
    return prefer(exact) ?? prefer(sameLanguage) ?? null;
  }
}

export function createBrowserTts(scope?: object): TtsProvider {
  return new BrowserTts(scope);
}
