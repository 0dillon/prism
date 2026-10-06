"use client";

import { useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { masteredConceptIds } from "@/lib/session/machine";
import { ProgressBar } from "../shared/ProgressBar";
import { QuizBlock } from "../shared/QuizBlock";
import {
  activeQuizItem,
  countOf,
  lessonProgress,
  orderedConcepts,
  sectionOf,
} from "../shared/lesson";
import { RENDERER_HEADING_ATTRIBUTE, type RendererProps } from "../types";
import { ConceptCard } from "./ConceptCard";
import { Feedback } from "./Feedback";
import { SummaryCard } from "./SummaryCard";
import { useCardInput } from "./useCardInput";

/**
 * The cards layout (PRD 5.6.1): one idea on one card, a quick question after every few
 * ideas, and a summary at the end. It is a view over the session: it draws `session` and
 * `profile` and calls `actions`, and keeps no progress of its own, so switching to another
 * layout and back loses nothing.
 *
 * Moving between cards works by swipe, tap, arrow keys, Space and the Next and Back
 * buttons, which are always visible. When a screen changes so that the control the learner
 * was using disappears, focus moves to the new card so it is never dropped.
 */
export default function CardsRenderer({ graph, session, profile, actions }: RendererProps) {
  const concepts = useMemo(() => orderedConcepts(graph), [graph]);
  const total = concepts.length;
  const concept = concepts[session.conceptIndex];
  const { phase } = session;
  const rootRef = useRef<HTMLDivElement>(null);

  const onLearning = phase === "learning";
  const input = useCardInput({
    enabled: onLearning,
    onNext: actions.next,
    onPrevious: actions.previous,
  });

  // Focus the new card when the screen changes, except after answering: the quiz block
  // moves focus to its own Continue button then. Skipped on first render, so opening the
  // page or switching layouts leaves focus to the page (and PrismRenderer's heading focus).
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (phase === "feedback") return;
    rootRef.current?.querySelector<HTMLElement>("[data-card-focus]")?.focus();
  }, [phase]);

  // Say which idea is showing when it changes, since the Next button keeps focus.
  const announcedIndex = useRef<number | null>(null);
  useEffect(() => {
    if (!onLearning || !concept) {
      announcedIndex.current = null;
      return;
    }
    if (announcedIndex.current !== null && announcedIndex.current !== session.conceptIndex) {
      announce(
        `Idea ${session.conceptIndex + 1} of ${total}: ${concept.title}. ${concept.summary}`,
      );
    }
    announcedIndex.current = session.conceptIndex;
  }, [onLearning, concept, session.conceptIndex, total]);

  const item = activeQuizItem(graph, session.activeQuizItemId);
  const progress = lessonProgress(session, total);
  const { feedback, content } = profile;

  return (
    <div
      ref={rootRef}
      data-layout="cards"
      {...input}
      className="mx-auto flex w-full max-w-3xl [touch-action:pan-y] flex-col gap-5 p-4"
    >
      <h1
        id="renderer-heading"
        tabIndex={-1}
        {...{ [RENDERER_HEADING_ATTRIBUTE]: "" }}
        className="text-2xl font-bold"
      >
        {graph.title}
        <span className="sr-only">, cards view</span>
      </h1>

      {feedback.progressBar && phase !== "intro" ? (
        <ProgressBar
          value={progress}
          label="Lesson progress"
          text={phase === "complete" ? "Complete" : `Idea ${session.conceptIndex + 1} of ${total}`}
        />
      ) : null}

      {feedback.streaks && session.streak > 0 && phase !== "complete" ? (
        <p className="font-semibold">
          <span aria-hidden="true">🔥 </span>
          Streak: {countOf(session.streak, "answer")} in a row
        </p>
      ) : null}

      {phase === "intro" ? (
        <section
          aria-label="About this lesson"
          data-card-focus=""
          tabIndex={-1}
          className="border-line bg-background flex flex-col gap-5 rounded-xl border p-6 outline-none sm:p-8"
        >
          <p className="text-xl">{graph.overview}</p>
          <p className="text-muted">{countOf(total, "idea")} in this lesson.</p>
          <div>
            <Button onClick={actions.start} disabled={total === 0}>
              Start
            </Button>
          </div>
          {total === 0 ? <p role="status">This lesson has no content yet.</p> : null}
        </section>
      ) : null}

      {onLearning && concept ? (
        <>
          <ConceptCard
            key={concept.id}
            concept={concept}
            positionLabel={`Idea ${session.conceptIndex + 1} of ${total}`}
            sectionTitle={sectionOf(graph, concept)?.title}
            showExamples={content.showExamples}
          />
          <nav aria-label="Card controls" className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              onClick={actions.previous}
              disabled={session.conceptIndex === 0}
            >
              Back
            </Button>
            <Button onClick={actions.next}>Next</Button>
            <Button variant="secondary" onClick={actions.requestQuiz}>
              Quiz me
            </Button>
          </nav>
          <p className="text-muted text-sm">
            Keys: right arrow or space for next, left arrow for back. On a touchscreen, swipe or tap
            the card.
          </p>
        </>
      ) : null}

      {(phase === "quiz" || phase === "feedback") && item ? (
        <div
          role="group"
          aria-label="Quick check"
          data-card-focus=""
          tabIndex={-1}
          className="outline-none"
        >
          <div className="border-line bg-background flex flex-col gap-4 rounded-xl border p-6 sm:p-8">
            <QuizBlock
              key={item.id}
              item={item}
              phase={phase}
              lastAnswer={session.lastAnswer}
              label="Quick check"
              large
              onAnswer={(correct) => actions.answer(item.id, correct)}
              onContinue={actions.continue}
            />
            {phase === "feedback" && session.lastAnswer?.quizItemId === item.id ? (
              <Feedback
                key={`${item.id}-${session.answeredCount}`}
                correct={session.lastAnswer.correct}
                profile={profile}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {phase === "complete" ? (
        <SummaryCard
          totalConcepts={total}
          masteredConcepts={masteredConceptIds(session).length}
          correctCount={session.correctCount}
          answeredCount={session.answeredCount}
          bestStreak={session.bestStreak}
          activeMs={session.activeMs}
          showStreak={feedback.streaks}
          onRestart={actions.restart}
        />
      ) : null}
    </div>
  );
}
