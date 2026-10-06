"use client";

import {
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { createBrowserStt, createBrowserTts } from "@/lib/speech/providers/browser";
import { masteredConceptIds } from "@/lib/session/machine";
import { ProgressBar } from "../shared/ProgressBar";
import { SummaryCard } from "../shared/SummaryCard";
import { countOf, lessonProgress, orderedConcepts } from "../shared/lesson";
import { RENDERER_HEADING_ATTRIBUTE, type RendererProps } from "../types";
import {
  createConversationController,
  type ConversationController,
  type ConversationStatus,
} from "./controller";
import { createEarconPlayer } from "./earcons";
import { ConversationServicesContext, type ConversationServices } from "./services";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useBargeInKey, useConversationShortcuts } from "./shortcuts";

type Live = Pick<RendererProps, "session" | "profile" | "actions" | "updateProfile">;

/** Builds the controller with getters that always read the latest props. */
function createLive(initial: Live, graph: RendererProps["graph"], services: ConversationServices) {
  let current = initial;
  const playEarcon = createEarconPlayer();
  const controller = createConversationController({
    lessonId: graph.lessonId,
    graph,
    getSession: () => current.session,
    getProfile: () => current.profile,
    actions: {
      start: () => current.actions.start(),
      next: () => current.actions.next(),
      previous: () => current.actions.previous(),
      requestQuiz: () => current.actions.requestQuiz(),
      answer: (id, correct) => current.actions.answer(id, correct),
      continue: () => current.actions.continue(),
      goTo: (index) => current.actions.goTo(index),
      restart: () => current.actions.restart(),
    },
    updateProfile: (patch) => current.updateProfile(patch),
    services,
    tts: typeof window === "undefined" ? null : createBrowserTts(),
    stt: typeof window === "undefined" ? null : createBrowserStt(),
    earcon: (kind) => {
      if (current.profile.audio.earcons) playEarcon(kind);
    },
  });
  return {
    controller,
    sync(next: Live) {
      current = next;
    },
  };
}

const STATUS_TEXT: Record<ConversationStatus, { icon: string; text: string }> = {
  idle: { icon: "●", text: "Ready" },
  speaking: { icon: "🔊", text: "Prism is speaking" },
  listening: { icon: "🎤", text: "Listening to you" },
  thinking: { icon: "…", text: "Thinking" },
  paused: { icon: "⏸", text: "Paused" },
};

/**
 * The conversation layout (PRD 5.6.3): Prism talks the lesson through, listens, and answers
 * questions from the lesson. Everything that can be said can also be typed, and everything
 * said is in a transcript that a screen reader can read, so voice is an extra and never the
 * only way. Prism's own voice can be switched off for learners who use their own screen reader.
 */
export default function ConversationRenderer({
  graph,
  session,
  profile,
  actions,
  updateProfile,
}: RendererProps) {
  const services = useContext(ConversationServicesContext);
  const concepts = useMemo(() => orderedConcepts(graph), [graph]);
  const total = concepts.length;

  // The controller is made once and told about each new set of props through `sync`.
  const [live] = useState(() =>
    createLive({ session, profile, actions, updateProfile }, graph, services),
  );
  const { controller } = live;
  useEffect(() => live.sync({ session, profile, actions, updateProfile }));

  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );

  // Follow the session: whatever changes it, the conversation says what happened.
  useEffect(() => controller.onSession(session), [controller, session]);
  // Stop talking and listening when the learner leaves this layout.
  useEffect(() => () => controller.stop(), [controller]);

  // Say each state change to a screen reader, once. The indicator is also on screen.
  const lastStatus = useRef<ConversationStatus>(state.status);
  useEffect(() => {
    if (lastStatus.current !== state.status) {
      lastStatus.current = state.status;
      announce(STATUS_TEXT[state.status].text);
    }
  }, [state.status]);

  const [helpOpen, setHelpOpen] = useState(false);
  useConversationShortcuts({
    togglePause: controller.togglePause,
    command: (intent) => void controller.command(intent),
    toggleListening: controller.toggleListening,
    showHelp: () => setHelpOpen(true),
  });
  // Any key stops Prism talking, at once.
  useBargeInKey(() => {
    if (controller.getState().status === "speaking") controller.interrupt();
  });

  const [draft, setDraft] = useState("");
  const inputId = useId();
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keep the newest line in view without moving focus.
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.transcript.length]);

  const { phase } = session;
  const indicator = STATUS_TEXT[state.status];
  const voiceInput = profile.audio.voiceInput && state.canListen;
  const speaking = state.status === "speaking";

  const quick = (label: string, intent: Parameters<ConversationController["command"]>[0]) => (
    <Button variant="secondary" onClick={() => void controller.command(intent)}>
      {label}
    </Button>
  );

  return (
    <div data-layout="conversation" className="mx-auto flex w-full max-w-3xl flex-col gap-5 p-4">
      <h1
        id="renderer-heading"
        // One label, so the name reads "Title, view" without stray spaces. It starts with the visible title.
        aria-label={`${graph.title}, conversation view`}
        tabIndex={-1}
        {...{ [RENDERER_HEADING_ATTRIBUTE]: "" }}
        className="text-2xl font-bold"
      >
        {graph.title}
      </h1>

      {profile.feedback.progressBar && phase !== "intro" ? (
        <ProgressBar
          value={lessonProgress(session, total)}
          label="Lesson progress"
          text={
            phase === "complete"
              ? "Complete"
              : `${session.seenConceptIds.length} of ${countOf(total, "idea")} heard`
          }
        />
      ) : null}

      <section
        aria-label="Conversation"
        className="border-line flex flex-col gap-4 rounded-xl border p-4"
      >
        <p
          role="status"
          className="flex items-center gap-2 font-semibold"
          data-conversation-status={state.status}
        >
          <span aria-hidden="true">{indicator.icon}</span>
          <span>{indicator.text}</span>
        </p>

        <div
          ref={logRef}
          role="log"
          aria-label="Conversation transcript"
          aria-relevant="additions"
          className="flex max-h-[45vh] min-h-32 flex-col gap-3 overflow-y-auto"
          tabIndex={0}
        >
          {state.transcript.map((entry) => (
            <p key={entry.id} data-role={entry.role}>
              <strong>{entry.role === "tutor" ? "Prism: " : "You: "}</strong>
              {entry.text}
            </p>
          ))}
        </div>

        {state.partial ? (
          <p className="text-muted" aria-hidden="true">
            Hearing: {state.partial}
          </p>
        ) : null}
        {state.error ? (
          <p role="alert" className="font-medium">
            {state.error}
          </p>
        ) : null}

        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft;
            setDraft("");
            void controller.submit(text);
          }}
        >
          <label htmlFor={inputId} className="font-medium">
            Type what you want to say
          </label>
          <div className="flex flex-wrap gap-3">
            <input
              id={inputId}
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              className="border-line bg-background min-h-11 min-w-0 flex-1 rounded-md border px-3 py-2"
            />
            <Button type="submit" disabled={!draft.trim()}>
              Send
            </Button>
            {voiceInput ? (
              <Button
                variant="secondary"
                aria-pressed={state.status === "listening"}
                onClick={controller.toggleListening}
              >
                {state.status === "listening" ? "Stop listening" : "Speak"}
              </Button>
            ) : null}
          </div>
        </form>
      </section>

      <nav aria-label="Conversation controls" className="flex flex-wrap items-center gap-3">
        {phase === "intro" ? quick("Start", { type: "next" }) : null}
        {phase === "learning" ? (
          <>
            {quick("Next", { type: "next" })}
            {quick("Repeat", { type: "repeat" })}
            {quick("Simpler", { type: "simplify" })}
            {quick("Quiz me", { type: "quiz_me" })}
          </>
        ) : null}
        {phase === "quiz" ? quick("Repeat", { type: "repeat" }) : null}
        {phase === "feedback" ? quick("Continue", { type: "next" }) : null}
        {phase === "complete" ? quick("Start again", { type: "next" }) : null}

        <Button
          variant="secondary"
          onClick={controller.togglePause}
          aria-pressed={state.status === "paused"}
        >
          {state.status === "paused" ? "Resume" : "Pause"}
        </Button>
        {speaking ? (
          <Button variant="secondary" onClick={() => controller.interrupt()}>
            Stop talking
          </Button>
        ) : null}
        {state.canSpeak ? (
          <Button
            variant="secondary"
            aria-pressed={state.muted}
            onClick={() => {
              controller.setMuted(!state.muted);
              announce(
                state.muted
                  ? "Prism's voice is on."
                  : "Prism's voice is off. Replies appear in the transcript.",
              );
            }}
          >
            {state.muted ? "Turn Prism's voice on" : "Turn Prism's voice off"}
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => setHelpOpen(true)}>
          Keyboard shortcuts
        </Button>
      </nav>

      {phase === "complete" ? (
        <SummaryCard
          totalConcepts={total}
          masteredConcepts={masteredConceptIds(session).length}
          correctCount={session.correctCount}
          answeredCount={session.answeredCount}
          bestStreak={session.bestStreak}
          activeMs={session.activeMs}
          showStreak={profile.feedback.streaks}
          onRestart={actions.restart}
        />
      ) : null}

      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
