import { matchSessionIntent } from "@/lib/ai/intents/local";
import type { ProfilePatch } from "@/lib/profile/merge";
import { gradeLocally, gradeShortAnswerLocally } from "@/lib/quiz/grade";
import type { KnowledgeGraph, QuizItem } from "@/lib/schemas/knowledge-graph";
import type { SessionIntent } from "@/lib/schemas/intents";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { masteredConceptIds, type LessonSession } from "@/lib/session/machine";
import { STT_ERROR_MESSAGES, type SttProvider } from "@/lib/speech/stt";
import {
  clampRate,
  MAX_RATE,
  MIN_RATE,
  TTS_ERROR_MESSAGES,
  type TtsProvider,
} from "@/lib/speech/tts";
import { activeQuizItem, formatActiveTime, orderedConcepts } from "../shared/lesson";
import type { SessionActions } from "../types";
import type { ConversationServices } from "./services";
import { createSpeechQueue } from "./speechQueue";
import { matchSpokenAnswer, spokenOptions, spokenQuestion } from "./spokenQuiz";

/**
 * The conversation (PRD 5.6.3): the tutor speaks, listens, works out what the learner
 * means, and acts on it. It owns no React state and no layout, so it is tested on its own.
 *
 * It follows the session rather than leading it. Whatever changes the session (a spoken
 * command, a typed one, a shortcut or a button) the conversation notices and says what
 * happened, so every route into the lesson sounds the same.
 */

export type ConversationStatus = "idle" | "speaking" | "listening" | "thinking" | "paused";

export interface TranscriptEntry {
  id: number;
  role: "tutor" | "learner";
  text: string;
}

export interface ConversationState {
  status: ConversationStatus;
  transcript: readonly TranscriptEntry[];
  /** Prism's own voice is off: replies appear in the transcript only. */
  muted: boolean;
  /** Whether this browser can speak and listen at all. */
  canSpeak: boolean;
  canListen: boolean;
  /** What is being heard right now, before it is final. */
  partial: string;
  /** The last problem, in words, for the screen. */
  error: string | null;
}

export type Earcon = "listening" | "correct" | "incorrect";

export interface ConversationDeps {
  lessonId: string;
  graph: Pick<KnowledgeGraph, "title" | "overview" | "sections" | "concepts" | "quizItems">;
  getSession: () => LessonSession;
  getProfile: () => RenderProfile;
  actions: SessionActions;
  updateProfile: (patch: ProfilePatch) => void;
  services: ConversationServices;
  tts: TtsProvider | null;
  stt: SttProvider | null;
  earcon?: (kind: Earcon) => void;
}

export interface ConversationController {
  getState(): ConversationState;
  subscribe(listener: (state: ConversationState) => void): () => void;
  /** Tell the conversation the session changed, so it can say what happened. */
  onSession(session: LessonSession): void;
  /** What the learner said or typed. */
  submit(text: string): Promise<void>;
  /** A command that did not come as words, such as a keyboard shortcut. */
  command(intent: SessionIntent): Promise<void>;
  toggleListening(): void;
  /** Stops the voice at once. `listen` then opens the microphone for the learner's turn. */
  interrupt(options?: { listen?: boolean }): void;
  togglePause(): void;
  setMuted(muted: boolean): void;
  /** Stops speaking, listening and any reply on the way. The controller can be used again. */
  stop(): void;
  /** Stops everything for good and drops listeners. */
  dispose(): void;
}

const MAX_SILENT_RETRIES = 1;
const RATE_STEP = 0.25;

export function createConversationController(deps: ConversationDeps): ConversationController {
  const { graph, actions, services, tts, stt } = deps;
  const concepts = orderedConcepts(graph);
  const queue = tts?.supported
    ? createSpeechQueue({
        tts,
        getRate: () => deps.getProfile().audio.rate,
        onError: (code) => set({ error: TTS_ERROR_MESSAGES[code] }),
      })
    : null;

  let state: ConversationState = {
    status: "idle",
    transcript: [],
    muted: false,
    canSpeak: queue !== null,
    canListen: stt?.supported === true,
    partial: "",
    error: null,
  };
  const listeners = new Set<(s: ConversationState) => void>();
  let nextId = 1;
  // Flags behind `status`.
  let paused = false;
  let thinking = 0;
  let listening = false;
  let silentRetries = 0;
  let retryListening = false;
  // Moves on whenever a new learner turn begins, so a slow reply to an old one is dropped.
  let turn = 0;
  let abort: AbortController | null = null;
  let previous: {
    phase: string;
    conceptIndex: number;
    item: string | null;
    answered: number;
  } | null = null;
  let pendingFeedback: string | null = null;
  let disposed = false;

  const speechOn = () => queue !== null && !state.muted;

  function status(): ConversationStatus {
    if (paused) return "paused";
    if (queue?.speaking) return "speaking";
    if (listening) return "listening";
    if (thinking > 0) return "thinking";
    return "idle";
  }
  function set(patch: Partial<ConversationState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    state = { ...state, status: status() };
    for (const listener of listeners) listener(state);
  }
  const refresh = () => set({});

  function add(role: TranscriptEntry["role"], text: string) {
    set({ transcript: [...state.transcript, { id: nextId++, role, text }] });
  }

  // ---- Speaking ------------------------------------------------------------------------

  /** Says something: shows it in the transcript and, if the voice is on, speaks it. Resolves true if spoken to the end. */
  async function say(text: string, options: { show?: boolean } = {}): Promise<boolean> {
    if (options.show !== false) add("tutor", text);
    if (!speechOn() || paused) return false;
    stopListening();
    const finished = queue!.say(text);
    refresh();
    const spoken = await finished;
    refresh();
    return spoken;
  }

  /** After the tutor has spoken, it is the learner's turn. */
  function handOver() {
    if (disposed || paused || !deps.getProfile().audio.voiceInput || !stt?.supported) return;
    startListening();
  }

  // ---- Listening -----------------------------------------------------------------------

  function startListening() {
    if (!stt || !stt.supported || listening || paused) return;
    queue?.cancel();
    listening = true;
    set({ partial: "", error: null });
    deps.earcon?.("listening");
    stt.start({
      onPartial: (text) => set({ partial: text }),
      onFinal: (text) => {
        silentRetries = 0;
        set({ partial: "" });
        void submit(text);
      },
      onError: (code) => {
        if (code === "aborted") return;
        // Silence is not a fault: try once more, then wait for the learner.
        if (code === "no_speech" && silentRetries < MAX_SILENT_RETRIES) {
          silentRetries++;
          retryListening = true;
          return;
        }
        silentRetries = 0;
        if (code !== "no_speech") set({ error: STT_ERROR_MESSAGES[code] });
      },
      onEnd: () => {
        listening = false;
        set({ partial: "" });
        if (retryListening) {
          retryListening = false;
          startListening();
        }
      },
    });
    refresh();
  }
  function stopListening() {
    retryListening = false;
    if (listening) stt?.abort();
    listening = false;
  }

  // ---- What to say about the lesson ------------------------------------------------------

  const conceptAt = (session: LessonSession) => concepts[session.conceptIndex];

  function conceptText(session: LessonSession): string {
    const concept = conceptAt(session);
    return concept ? `${concept.title}. ${concept.summary}` : "";
  }

  function welcomeText(): string {
    return `Welcome. This lesson is ${graph.title}. ${graph.overview} Press Start, or say start, when you are ready.`;
  }

  function resultText(item: QuizItem, correct: boolean): string {
    const answer =
      item.type === "true_false" ? (item.answer === "true" ? "True" : "False") : item.answer;
    const lead = correct ? "Correct." : `Not quite. The answer is ${answer}.`;
    const extra = pendingFeedback ? ` ${pendingFeedback}` : "";
    return `${lead}${extra} ${item.explanation}`.replace(/\s+/g, " ").trim();
  }

  function summaryText(session: LessonSession): string {
    const mastered = masteredConceptIds(session).length;
    const time = formatActiveTime(session.activeMs).toLowerCase();
    return `That is the end of the lesson. You mastered ${mastered} of ${concepts.length} ideas, and you spent ${time}. Say start again to go through it once more.`;
  }

  function whereText(session: LessonSession): string {
    const concept = conceptAt(session);
    if (session.phase === "intro") return "We have not started yet. Say start when you are ready.";
    if (session.phase === "complete") return "We have finished the lesson.";
    if (!concept) return "I am not sure where we are.";
    const section = graph.sections.find((s) => s.id === concept.sectionId)?.title;
    const left = concepts.length - (session.conceptIndex + 1);
    const where = `You are on idea ${session.conceptIndex + 1} of ${concepts.length}, ${concept.title}${section ? `, in ${section}` : ""}.`;
    const quiz =
      session.phase === "quiz" || session.phase === "feedback" ? " You are in a quick check." : "";
    return `${where}${quiz} ${left === 0 ? "This is the last idea." : `${left} more ${left === 1 ? "idea" : "ideas"} to go.`}`;
  }

  /** Says what is current, as a repeat: the idea, the question, or the result. */
  async function sayCurrent(): Promise<void> {
    const session = deps.getSession();
    const item = activeQuizItem(graph, session.activeQuizItemId);
    let spoken: boolean;
    switch (session.phase) {
      case "learning":
        spoken = await say(conceptText(session));
        break;
      case "quiz":
        spoken = await say(item ? spokenQuestion(item) : whereText(session));
        break;
      case "feedback":
        spoken = await say(
          item && session.lastAnswer
            ? resultText(item, session.lastAnswer.correct)
            : whereText(session),
        );
        break;
      case "complete":
        spoken = await say(summaryText(session));
        break;
      default:
        spoken = await say(welcomeText());
    }
    if (spoken) handOver();
  }

  // ---- Following the session -------------------------------------------------------------

  const snapshot = (s: LessonSession) => ({
    phase: s.phase,
    conceptIndex: s.conceptIndex,
    item: s.activeQuizItemId,
    answered: s.answeredCount,
  });

  async function narrate(session: LessonSession, before: NonNullable<typeof previous>) {
    const mine = turn;
    const item = activeQuizItem(graph, session.activeQuizItemId);
    switch (session.phase) {
      case "learning": {
        const first = before.phase === "intro";
        const text =
          conceptText(session) +
          (first
            ? " Say next to go on, repeat to hear it again, simpler for easier words, or quiz me."
            : "");
        if ((await say(text)) && mine === turn) handOver();
        return;
      }
      case "quiz": {
        if (!item) return;
        const opening = before.phase === "learning" ? "Quick question. " : "";
        if ((await say(opening + spokenQuestion(item))) && mine === turn) handOver();
        return;
      }
      case "feedback": {
        if (!item || !session.lastAnswer) return;
        const correct = session.lastAnswer.correct;
        deps.earcon?.(correct ? "correct" : "incorrect");
        const spoken = await say(resultText(item, correct));
        pendingFeedback = null;
        // Hands-free: when the result has been spoken, carry on.
        if (spoken && mine === turn && !paused) actions.continue();
        return;
      }
      case "complete":
        if ((await say(summaryText(session))) && mine === turn) handOver();
        return;
      default:
        add("tutor", welcomeText());
    }
  }

  function onSession(session: LessonSession) {
    const before = previous;
    const now = snapshot(session);
    previous = now;
    if (!before) {
      // Opening the page: say where we are in text, and wait for the learner. A page may not
      // speak by itself, so nothing is spoken until the learner does something.
      add(
        "tutor",
        session.phase === "intro"
          ? welcomeText()
          : `Welcome back. ${whereText(session)} Press Space, or say repeat, to hear it.`,
      );
      return;
    }
    const changed =
      before.phase !== now.phase ||
      before.conceptIndex !== now.conceptIndex ||
      before.item !== now.item ||
      before.answered !== now.answered;
    if (!changed) return;
    // A change the learner did not speak (a button, a shortcut) still ends whatever was being said.
    turn++;
    queue?.cancel();
    void narrate(session, before);
  }

  // ---- Commands ---------------------------------------------------------------------------

  function clampStep(rate: number, direction: "slower" | "faster"): number {
    return clampRate(rate + (direction === "faster" ? RATE_STEP : -RATE_STEP));
  }

  async function tutorTurn(
    intent: Extract<SessionIntent, { type: "question" | "elaborate" | "example" | "simplify" }>,
    mine: number,
  ) {
    const session = deps.getSession();
    const concept = conceptAt(session) ?? concepts[0];
    if (!concept) return;
    const request =
      intent.type === "question"
        ? ({ type: "question", text: intent.text } as const)
        : ({ type: intent.type } as const);

    abort = new AbortController();
    const utterance = speechOn() && !paused ? queue!.begin() : null;
    try {
      const text = await services.tutorTurn(
        { lessonId: deps.lessonId, conceptId: concept.id, intent: request },
        { onText: (piece) => utterance?.push(piece), signal: abort.signal },
      );
      if (mine !== turn) {
        utterance?.end();
        return;
      }
      utterance?.end();
      add("tutor", text.trim() || "I am not sure how to answer that.");
      if (utterance) {
        if ((await utterance.finished) && mine === turn) handOver();
      } else {
        handOver();
      }
    } catch (error) {
      utterance?.end();
      queue?.cancel();
      if (mine !== turn || (error as { name?: string })?.name === "AbortError") return;
      const message = error instanceof Error ? error.message : "I could not answer that just now.";
      await say(message);
    }
  }

  async function answer(item: QuizItem, given: string, mine: number) {
    if (item.type === "short_answer") {
      let grade: { correct: boolean; feedback?: string };
      try {
        grade = await services.gradeShortAnswer({
          lessonId: deps.lessonId,
          quizItemId: item.id,
          answer: given,
        });
      } catch {
        // Grading is not available: fall back to the strict local check.
        grade = { correct: gradeShortAnswerLocally(item, given).correct };
      }
      if (mine !== turn) return;
      pendingFeedback = grade.feedback ?? null;
      actions.answer(item.id, grade.correct);
      return;
    }
    actions.answer(item.id, gradeLocally(item, given).correct);
  }

  async function dispatch(intent: SessionIntent, mine: number): Promise<void> {
    const session = deps.getSession();
    const phase = session.phase;
    const learning = phase === "learning";

    switch (intent.type) {
      case "next":
      case "resume": {
        if (paused) {
          paused = false;
          refresh();
          return sayCurrent();
        }
        if (phase === "intro") return actions.start();
        if (learning) return actions.next();
        if (phase === "feedback") return actions.continue();
        if (phase === "complete") return actions.restart();
        await say("Answer the question first, or say repeat to hear it again.");
        handOver();
        return;
      }
      case "previous":
        if (learning) return actions.previous();
        await say("I can only go back while we are reading an idea.");
        handOver();
        return;
      case "repeat":
        return sayCurrent();
      case "quiz_me":
        if (learning) return actions.requestQuiz();
        if (phase === "intro") return actions.start();
        await say(
          phase === "complete" ? "The lesson is finished." : "We are already in a question.",
        );
        handOver();
        return;
      case "pause":
        paused = true;
        queue?.cancel();
        stopListening();
        refresh();
        add("tutor", "Paused. Say resume, or press Space, when you are ready.");
        return;
      case "where_am_i":
        await say(whereText(session));
        handOver();
        return;
      case "go_to": {
        if (!learning) {
          await say("I can jump to another idea while we are reading.");
          handOver();
          return;
        }
        const wanted = intent.target.trim().toLowerCase();
        const index = concepts.findIndex((c) => c.title.toLowerCase() === wanted);
        const loose =
          index >= 0 ? index : concepts.findIndex((c) => c.title.toLowerCase().includes(wanted));
        if (loose < 0) {
          await say(`I could not find ${intent.target} in this lesson.`);
          handOver();
          return;
        }
        return actions.goTo(loose);
      }
      case "set_rate": {
        const current = deps.getProfile().audio.rate;
        const next = clampStep(current, intent.direction);
        if (next === current) {
          await say(
            next >= MAX_RATE
              ? "I am already as fast as I go."
              : next <= MIN_RATE
                ? "I am already as slow as I go."
                : "Okay.",
          );
        } else {
          deps.updateProfile({ audio: { rate: next } });
          await say(intent.direction === "faster" ? "Okay, a bit faster." : "Okay, a bit slower.");
        }
        handOver();
        return;
      }
      case "change_profile": {
        try {
          const result = await services.parseNeeds(intent.request, deps.getProfile());
          if (mine !== turn) return;
          if (result.ok) {
            deps.updateProfile(result.profile as ProfilePatch);
            await say(result.explanation);
          } else {
            await say(result.message);
          }
        } catch {
          await say("I could not change your settings just now. You can use the Settings button.");
        }
        handOver();
        return;
      }
      case "simplify":
      case "elaborate":
      case "example":
      case "question": {
        if (!learning) {
          await say(
            phase === "quiz" || phase === "feedback"
              ? "Let us finish this question first, then ask me."
              : "We can talk about the ideas once we start.",
          );
          handOver();
          return;
        }
        return tutorTurn(intent, mine);
      }
      case "answer":
        // The model named an answer; the question in hand decides what it means.
        return answerQuestion(intent.value, mine);
      case "unknown":
      default:
        add("tutor", "Sorry, I did not get that. You can say next, repeat, simpler, or quiz me.");
        if (speechOn()) await say("Sorry, I did not get that.", { show: false });
        handOver();
    }
  }

  async function answerQuestion(said: string, mine: number): Promise<void> {
    const session = deps.getSession();
    const item = activeQuizItem(graph, session.activeQuizItemId);
    if (!item) return;
    const heard = matchSpokenAnswer(item, said);
    if (heard.kind === "choice") return answer(item, heard.value, mine);
    if (heard.kind === "text") return answer(item, heard.value, mine);

    // Not an answer. It may be a command about the question, such as "repeat the options".
    const intent =
      matchSessionIntent(said) ?? (await services.resolveIntent(said, intentContext()));
    if (mine !== turn) return;
    if (/option/i.test(said) && /repeat|again|read/i.test(said)) {
      await say(spokenOptions(item) || spokenQuestion(item));
      handOver();
      return;
    }
    if (
      ["repeat", "pause", "resume", "where_am_i", "set_rate", "change_profile"].includes(
        intent.type,
      )
    ) {
      return dispatch(intent, mine);
    }
    await say(
      item.type === "true_false"
        ? "I did not catch that. Say true or false, or say repeat."
        : "I did not catch that. Say the letter or the answer, or say repeat to hear the options again.",
    );
    handOver();
  }

  function intentContext() {
    const session = deps.getSession();
    const item = activeQuizItem(graph, session.activeQuizItemId);
    return {
      lessonId: deps.lessonId,
      lessonTitle: graph.title,
      currentConcept: conceptAt(session)?.title,
      conceptTitles: concepts.map((c) => c.title),
      pendingQuestion: session.phase === "quiz" ? item?.prompt : undefined,
      paused,
    };
  }

  async function submit(text: string): Promise<void> {
    const said = text.trim();
    if (!said || disposed) return;
    const mine = ++turn;
    abort?.abort();
    queue?.cancel();
    stopListening();
    add("learner", said);
    thinking++;
    refresh();
    try {
      const session = deps.getSession();
      if (session.phase === "quiz") {
        await answerQuestion(said, mine);
        return;
      }
      // Local phrases are settled at once; the rest may take a moment.
      const intent = await services.resolveIntent(said, intentContext());
      if (mine !== turn) return;
      await dispatch(intent, mine);
    } finally {
      thinking--;
      refresh();
    }
  }

  async function command(intent: SessionIntent): Promise<void> {
    const mine = ++turn;
    abort?.abort();
    queue?.cancel();
    stopListening();
    thinking++;
    refresh();
    try {
      await dispatch(intent, mine);
    } finally {
      thinking--;
      refresh();
    }
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    onSession,
    submit,

    command,

    toggleListening() {
      if (listening) {
        stt?.stop();
        return;
      }
      if (paused) {
        paused = false;
      }
      queue?.cancel();
      silentRetries = 0;
      startListening();
    },

    interrupt(options = {}) {
      turn++;
      abort?.abort();
      queue?.cancel();
      refresh();
      if (options.listen) startListening();
    },

    togglePause() {
      if (paused) {
        paused = false;
        refresh();
        void sayCurrent();
      } else {
        void command({ type: "pause" });
      }
    },

    setMuted(muted) {
      if (muted) {
        queue?.cancel();
        abort?.abort();
      }
      set({ muted });
    },

    stop() {
      turn++;
      abort?.abort();
      queue?.cancel();
      stopListening();
      refresh();
    },

    dispose() {
      disposed = true;
      abort?.abort();
      queue?.cancel();
      stopListening();
      listeners.clear();
    },
  };
}
