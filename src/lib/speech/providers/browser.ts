import type { SttErrorCode, SttHandlers, SttProvider } from "../stt";

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
