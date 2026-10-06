"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { masteredConceptIds } from "@/lib/session/machine";
import { Feedback } from "../cards/Feedback";
import { useCardInput } from "../cards/useCardInput";
import { MarkdownBody } from "../shared/markdown";
import { ProgressBar } from "../shared/ProgressBar";
import { QuizBlock } from "../shared/QuizBlock";
import { SummaryCard } from "../shared/SummaryCard";
import {
  activeQuizItem,
  countOf,
  lessonProgress,
  orderedConcepts,
  sectionOf,
} from "../shared/lesson";
import { useVariants } from "../reader/useVariants";
import { RENDERER_HEADING_ATTRIBUTE, type RendererProps } from "../types";
import { Fingerspell } from "./Fingerspell";
import { SignClip } from "./SignClip";
import { SIGN_NOTICE, SignClipsContext } from "./signs";

/**
 * The visual layout (PRD 5.6.4): plain-language concept cards with the key term signed or
 * fingerspelled, for learners who take everything in by eye. Nothing here makes a sound:
 * there is no speech, no audio element and no earcon, and every result is shown with an
 * icon, words and colour, and optionally a vibration on a phone.
 *
 * Signs are for key terms only, and the page says so. A concept with a verified clip shows
 * a "See it signed" button; one without shows the term fingerspelled and labelled as such.
 */
export default function VisualRenderer({ graph, session, profile, actions }: RendererProps) {
  const clips = useContext(SignClipsContext);
  const concepts = useMemo(() => orderedConcepts(graph), [graph]);
  const total = concepts.length;
  const concept = concepts[session.conceptIndex];
  const { phase } = session;
  const learning = phase === "learning";
  const { visual, content, feedback } = profile;
  const rootRef = useRef<HTMLDivElement>(null);

  const conceptIds = useMemo(() => (learning && concept ? [concept.id] : []), [learning, concept]);
  const variants = useVariants({
    lessonId: graph.lessonId,
    graphVersion: session.graphVersion,
    defaultLevel: content.readingLevel,
    conceptIds,
  });

  const [signedOpen, setSignedOpen] = useState<string | null>(null);
  const input = useCardInput({
    enabled: learning,
    onNext: actions.next,
    onPrevious: actions.previous,
  });

  // Move focus to the new card when the screen changes, except after answering.
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (phase === "feedback") return;
    rootRef.current?.querySelector<HTMLElement>("[data-card-focus]")?.focus();
  }, [phase]);

  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!learning || !concept) {
      announced.current = null;
      return;
    }
    if (announced.current !== null && announced.current !== session.conceptIndex) {
      announce(`Idea ${session.conceptIndex + 1} of ${total}: ${concept.title}.`);
    }
    announced.current = session.conceptIndex;
  }, [learning, concept, session.conceptIndex, total]);

  const item = activeQuizItem(graph, session.activeQuizItemId);
  const clip = concept ? clips[concept.id] : undefined;
  const showSigns = visual.signClips && Boolean(concept?.keyTerm);
  const body = concept ? (variants.bodyFor(concept.id) ?? concept.body) : "";

  return (
    <div
      ref={rootRef}
      data-layout="visual"
      {...input}
      className="mx-auto flex w-full max-w-3xl [touch-action:pan-y] flex-col gap-5 p-4"
    >
      <h1
        id="renderer-heading"
        // One label, so the name reads "Title, view" without stray spaces. It starts with the visible title.
        aria-label={`${graph.title}, visual view`}
        tabIndex={-1}
        {...{ [RENDERER_HEADING_ATTRIBUTE]: "" }}
        className="text-2xl font-bold"
      >
        {graph.title}
      </h1>

      {visual.signClips ? <p className="text-muted">{SIGN_NOTICE}</p> : null}

      {feedback.progressBar && phase !== "intro" ? (
        <ProgressBar
          value={lessonProgress(session, total)}
          label="Lesson progress"
          text={phase === "complete" ? "Complete" : `Idea ${session.conceptIndex + 1} of ${total}`}
        />
      ) : null}

      {phase === "intro" ? (
        <section
          aria-label="About this lesson"
          data-card-focus=""
          tabIndex={-1}
          className="border-line bg-background flex flex-col gap-5 rounded-xl border p-6 outline-none"
        >
          <p className="text-xl">{graph.overview}</p>
          <p className="text-muted">{countOf(total, "idea")} in this lesson.</p>
          <div>
            <Button onClick={actions.start} disabled={total === 0}>
              Start
            </Button>
          </div>
        </section>
      ) : null}

      {learning && concept ? (
        <>
          <article
            key={concept.id}
            aria-labelledby={`visual-title-${concept.id}`}
            data-card-focus=""
            tabIndex={-1}
            className="border-line bg-background flex min-h-[50vh] flex-col gap-5 rounded-xl border p-6 outline-none sm:p-8"
          >
            <p className="text-muted text-sm">
              {[`Idea ${session.conceptIndex + 1} of ${total}`, sectionOf(graph, concept)?.title]
                .filter(Boolean)
                .join(" · ")}
            </p>
            <h2 id={`visual-title-${concept.id}`} className="text-3xl font-bold">
              {concept.title}
            </h2>

            <MarkdownBody markdown={body} className="flex flex-col gap-3 text-xl" />

            {variants.statusFor(concept.id) === "loading" ? (
              <p role="status">Making this simpler…</p>
            ) : null}

            {content.showExamples && concept.examples[0] ? (
              <div className="bg-surface rounded-md p-4">
                <p className="font-semibold">For example</p>
                <p>{concept.examples[0]}</p>
              </div>
            ) : null}

            {concept.keyTerm && concept.definition ? (
              <p className="border-line rounded-md border-s-4 ps-4">
                <span className="font-semibold">{concept.keyTerm}</span>
                {": "}
                {concept.definition}
              </p>
            ) : null}

            {showSigns && concept.keyTerm ? (
              clip ? (
                <div className="flex flex-col gap-3">
                  <div>
                    <Button
                      variant="secondary"
                      aria-expanded={signedOpen === concept.id}
                      aria-controls={`visual-sign-${concept.id}`}
                      onClick={() => setSignedOpen(signedOpen === concept.id ? null : concept.id)}
                    >
                      See it signed
                    </Button>
                  </div>
                  <div id={`visual-sign-${concept.id}`} hidden={signedOpen !== concept.id}>
                    {signedOpen === concept.id ? (
                      <SignClip clip={clip} term={concept.keyTerm} />
                    ) : null}
                  </div>
                </div>
              ) : (
                <Fingerspell term={concept.keyTerm} />
              )
            ) : null}
          </article>

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
          <div className="border-line bg-background flex flex-col gap-4 rounded-xl border p-6">
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
