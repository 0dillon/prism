"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { masteredConceptIds } from "@/lib/session/machine";
import type { Concept } from "@/lib/schemas/knowledge-graph";
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
import { useReducedMotion } from "../shared/useReducedMotion";
import { RENDERER_HEADING_ATTRIBUTE, type RendererProps } from "../types";
import { buildConceptContent, buildScript } from "./content";
import { backTarget, isLastPage, pageOf, stepsToLeave } from "./paging";
import { ReadAloud } from "./ReadAloud";
import { ReaderConcept } from "./ReaderConcept";
import { useVariants } from "./useVariants";

const NO_IDS: readonly string[] = [];

/**
 * The reading layout (PRD 5.6.2): the lesson as headings, paragraphs and lists, shown one
 * idea, one section or all at once (`content.chunkSize`). Every visual setting arrives
 * through the page's custom properties, so a slider in Settings restyles it without
 * touching this code. It is a view over the session, like every renderer.
 *
 * Headings are sequential: the lesson title is the h1, a section is an h2 and a concept is
 * an h3. Quiz questions appear in place below the text, at the learner's cadence, and
 * answering uses the same session actions as the other layouts.
 */
export default function ReaderRenderer({
  graph,
  session,
  profile,
  actions,
  updateProfile,
}: RendererProps) {
  const concepts = useMemo(() => orderedConcepts(graph), [graph]);
  const total = concepts.length;
  const { phase } = session;
  const { content: contentSettings, typography, audio, feedback } = profile;
  const chunk = contentSettings.chunkSize;
  const reading = phase === "learning" || phase === "quiz" || phase === "feedback";

  const page = useMemo(
    () => (reading ? pageOf(concepts, session.conceptIndex, chunk) : []),
    [reading, concepts, session.conceptIndex, chunk],
  );
  const pageIds = useMemo(() => (page.length > 0 ? page.map((c) => c.id) : NO_IDS), [page]);
  const pageKey = pageIds.join(",");

  const variants = useVariants({
    lessonId: graph.lessonId,
    graphVersion: session.graphVersion,
    defaultLevel: contentSettings.readingLevel,
    conceptIds: pageIds,
  });

  const contents = page.map((concept) =>
    buildConceptContent(concept, {
      showExamples: contentSettings.showExamples,
      variantBody: variants.bodyFor(concept.id),
    }),
  );
  const script = buildScript(contents);

  // Highlight while reading aloud, if the learner asked for it.
  const [activeSentenceId, setActiveSentenceId] = useState<string | null>(null);
  const markSentences = audio.readAloud && audio.syncHighlight !== "off";
  const reducedMotion = useReducedMotion(profile.visual.reducedMotion);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeSentenceId) return;
    const target = [...(rootRef.current?.querySelectorAll("[data-sentence]") ?? [])].find(
      (el) => el.getAttribute("data-sentence") === activeSentenceId,
    );
    target?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
  }, [activeSentenceId, reducedMotion]);

  // When the screen changes and the control the learner used is gone, focus the new
  // content: the first heading on a new page, or the question. Not after answering (the
  // quiz block focuses Continue) and not on first render.
  const previous = useRef({ phase, pageKey });
  useEffect(() => {
    const before = previous.current;
    previous.current = { phase, pageKey };
    if (before.phase === phase && before.pageKey === pageKey) return;
    if (phase === "feedback" || phase === "intro") return;
    const selector =
      phase === "learning"
        ? "[data-page-focus]"
        : phase === "quiz"
          ? "[data-quiz-focus]"
          : "[data-summary-focus]";
    const target = rootRef.current?.querySelector<HTMLElement>(selector);
    target?.focus();
    target?.scrollIntoView?.({ block: "start", behavior: "auto" });
  }, [phase, pageKey]);

  const item = activeQuizItem(graph, session.activeQuizItemId);
  const progress = lessonProgress(session, total);

  // Group the page's concepts by section, so each section is one heading.
  const groups = page.reduce<Array<{ sectionId: string; concepts: Concept[] }>>((acc, concept) => {
    const last = acc[acc.length - 1];
    if (last && last.sectionId === concept.sectionId) last.concepts.push(concept);
    else acc.push({ sectionId: concept.sectionId, concepts: [concept] });
    return acc;
  }, []);

  const goBack = backTarget(concepts, session.conceptIndex, chunk);
  const leave = () => {
    const steps = stepsToLeave(concepts, session.conceptIndex, chunk);
    // Each press is one concept for the session; a quiz that falls due stops the rest.
    for (let i = 0; i < steps; i++) actions.next();
  };
  const last = isLastPage(concepts, session.conceptIndex, chunk);
  const nextLabel = last ? "Finish" : chunk === "section" ? "Next section" : "Next idea";

  return (
    <div
      ref={rootRef}
      data-layout="reader"
      className="mx-auto flex w-full max-w-[var(--measure)] flex-col gap-6 p-4"
    >
      <h1
        id="renderer-heading"
        // One label, so the name reads "Title, view" without stray spaces. It starts with the visible title.
        aria-label={`${graph.title}, reading view`}
        tabIndex={-1}
        {...{ [RENDERER_HEADING_ATTRIBUTE]: "" }}
        className="text-3xl font-bold"
      >
        {graph.title}
      </h1>

      {feedback.progressBar && phase !== "intro" ? (
        <ProgressBar
          value={progress}
          label="Lesson progress"
          text={
            phase === "complete"
              ? "Complete"
              : `${session.seenConceptIds.length} of ${countOf(total, "idea")} read`
          }
        />
      ) : null}

      {phase === "intro" ? (
        <section aria-label="About this lesson" className="flex flex-col gap-4">
          <p className="text-lg">{graph.overview}</p>
          <p className="text-muted">{countOf(total, "idea")} in this lesson.</p>
          <div>
            <Button onClick={actions.start} disabled={total === 0}>
              Start
            </Button>
          </div>
          {total === 0 ? <p role="status">This lesson has no content yet.</p> : null}
        </section>
      ) : null}

      {reading ? (
        <>
          {audio.readAloud ? (
            <ReadAloud
              script={script}
              rate={audio.rate}
              onRateChange={(rate) => updateProfile({ audio: { rate } })}
              onActiveChange={setActiveSentenceId}
            />
          ) : null}

          {groups.map((group) => {
            const section = sectionOf(graph, group.concepts[0]);
            const sectionHeadingId = `reader-section-${group.sectionId}`;
            const body = group.concepts.map((concept) => {
              const content = contents.find((c) => c.concept.id === concept.id);
              if (!content) return null;
              return (
                <ReaderConcept
                  key={concept.id}
                  content={content}
                  titleTag={section ? "h3" : "h2"}
                  focusTarget={concept.id === page[0]?.id}
                  anchors={typography.wordAnchors}
                  markSentences={markSentences}
                  activeSentenceId={activeSentenceId}
                  level={variants.levelFor(concept.id)}
                  status={variants.statusFor(concept.id)}
                  error={variants.errorFor(concept.id)}
                  canSimplify={variants.canSimplify(concept.id)}
                  onSimpler={() => variants.simpler(concept.id)}
                  onOriginal={() => variants.original(concept.id)}
                  onRetry={() => variants.retry(concept.id)}
                />
              );
            });
            return section ? (
              <section
                key={group.sectionId}
                aria-labelledby={sectionHeadingId}
                className="flex flex-col gap-6"
              >
                <h2 id={sectionHeadingId} className="text-xl font-semibold">
                  {section.title}
                </h2>
                {body}
              </section>
            ) : (
              <div key={group.sectionId} className="flex flex-col gap-6">
                {body}
              </div>
            );
          })}

          {phase === "learning" ? (
            <nav aria-label="Reading controls" className="flex flex-wrap items-center gap-3">
              {goBack !== null ? (
                <Button variant="secondary" onClick={() => actions.goTo(goBack)}>
                  Back
                </Button>
              ) : null}
              <Button onClick={leave}>{nextLabel}</Button>
              <Button variant="secondary" onClick={actions.requestQuiz}>
                Quiz me
              </Button>
            </nav>
          ) : null}

          {(phase === "quiz" || phase === "feedback") && item ? (
            <div
              role="group"
              aria-label="Quick check"
              data-quiz-focus=""
              tabIndex={-1}
              className="border-line rounded-md border p-4 outline-none"
            >
              <QuizBlock
                key={item.id}
                item={item}
                phase={phase}
                lastAnswer={session.lastAnswer}
                label="Quick check"
                onAnswer={(correct) => actions.answer(item.id, correct)}
                onContinue={actions.continue}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {phase === "complete" ? (
        <div data-summary-focus="" tabIndex={-1} className="outline-none">
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
        </div>
      ) : null}
    </div>
  );
}
