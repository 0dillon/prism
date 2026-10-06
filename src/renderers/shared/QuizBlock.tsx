"use client";

import { useEffect, useId, useRef, useState } from "react";
import { announce } from "@/lib/a11y/live-region";
import { gradeLocally, gradeShortAnswerLocally } from "@/lib/quiz/grade";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";

export interface ShortAnswerGrade {
  correct: boolean;
  feedback?: string;
}

export interface QuizBlockProps {
  item: QuizItem;
  /** "quiz" while answering, "feedback" once an answer is in. Driven by the session. */
  phase: "quiz" | "feedback";
  lastAnswer: { quizItemId: string; correct: boolean } | null;
  onAnswer: (correct: boolean, value: string) => void;
  onContinue: () => void;
  /** Grades a short answer, for example with the LLM. If it fails, the local check is used. */
  gradeShortAnswer?: (value: string) => Promise<ShortAnswerGrade>;
  /** Shown above the question, so a renderer can say "Question 1 of 2". */
  label?: string;
  /** Bigger text and targets, for touch layouts such as cards. */
  large?: boolean;
}

const optionClass =
  "border-line bg-background text-foreground min-h-11 w-full cursor-pointer rounded-md border px-4 py-3 text-start font-medium disabled:cursor-default";
// Large targets for touch: at least 56px tall, over the 44px minimum.
const largeOptionClass = `${optionClass} min-h-14 text-lg`;

/**
 * One quiz question, for every renderer (PRD 5.6). Multiple choice and true/false are graded
 * locally. The question and answer controls are real buttons and a text field, so it is
 * operable by keyboard and screen reader. Correct and incorrect are shown with an icon and
 * words, never colour alone, and nothing is conveyed by sound.
 */
export function QuizBlock({
  item,
  phase,
  lastAnswer,
  onAnswer,
  onContinue,
  gradeShortAnswer,
  label,
  large = false,
}: QuizBlockProps) {
  const questionId = useId();
  const inputId = useId();
  const [given, setGiven] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [grading, setGrading] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const continueRef = useRef<HTMLButtonElement>(null);

  const answered = phase === "feedback" && lastAnswer?.quizItemId === item.id;
  const correct = answered && lastAnswer?.correct === true;

  // After an answer, move to Continue so the next step is one key press away.
  useEffect(() => {
    if (answered) continueRef.current?.focus();
  }, [answered]);

  const resultText = correct ? "Correct." : `Not quite. The answer is ${displayAnswer(item)}.`;

  useEffect(() => {
    if (answered) announce(`${resultText} ${item.explanation}`);
    // Announce once per answer, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, item.id]);

  const choose = (value: string) => {
    if (answered || grading) return;
    setGiven(value);
    onAnswer(gradeLocally(item, value).correct, value);
  };

  const submitShort = async () => {
    if (answered || grading) return;
    const value = typed.trim();
    if (!value) return;
    setGiven(value);
    setGrading(true);
    let grade: ShortAnswerGrade;
    try {
      grade = gradeShortAnswer
        ? await gradeShortAnswer(value)
        : gradeShortAnswerLocally(item, value);
    } catch {
      // The grader is down or slow: fall back to the strict local check.
      grade = gradeShortAnswerLocally(item, value);
    }
    setNote(grade.feedback ?? null);
    setGrading(false);
    onAnswer(grade.correct, value);
  };

  const options =
    item.type === "mcq"
      ? (item.options ?? [])
      : item.type === "true_false"
        ? ["true", "false"]
        : [];

  return (
    <section aria-labelledby={questionId} className="flex flex-col gap-4">
      {label ? <p className="text-muted text-sm">{label}</p> : null}
      <p id={questionId} className="text-lg font-semibold">
        {item.prompt}
      </p>

      {item.type !== "short_answer" ? (
        <div role="group" aria-labelledby={questionId}>
          <ul className="flex flex-col gap-3">
            {options.map((option) => {
              const isCorrect = option === item.answer;
              const wasChosen = given === option;
              const text =
                item.type === "true_false" ? (option === "true" ? "True" : "False") : option;
              return (
                <li key={option}>
                  <button
                    type="button"
                    className={large ? largeOptionClass : optionClass}
                    disabled={answered}
                    aria-pressed={answered ? wasChosen : undefined}
                    onClick={() => choose(option)}
                  >
                    {text +
                      (answered && isCorrect ? " (correct answer)" : "") +
                      (answered && wasChosen && !isCorrect ? " (your answer)" : "")}
                    {answered ? (
                      <span aria-hidden="true">{isCorrect ? " ✓" : wasChosen ? " ✗" : ""}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submitShort();
          }}
        >
          <label htmlFor={inputId} className="font-medium">
            Your answer
          </label>
          <input
            id={inputId}
            type="text"
            value={answered ? (given ?? typed) : typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={answered || grading}
            autoComplete="off"
            className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
          />
          {!answered ? (
            <button
              type="submit"
              disabled={grading || !typed.trim()}
              className="bg-accent text-accent-foreground min-h-11 min-w-11 cursor-pointer rounded-md px-4 py-2 font-semibold disabled:opacity-60"
            >
              {grading ? "Checking…" : "Check answer"}
            </button>
          ) : null}
        </form>
      )}

      {answered ? (
        <div className="border-line flex flex-col gap-3 rounded-md border p-4">
          <p className="flex items-start gap-2 font-semibold">
            <span aria-hidden="true">{correct ? "✓" : "✗"}</span>
            <span>{resultText}</span>
          </p>
          {note ? <p>{note}</p> : null}
          <p>{item.explanation}</p>
          <div>
            <button
              ref={continueRef}
              type="button"
              onClick={onContinue}
              className="bg-accent text-accent-foreground min-h-11 min-w-11 cursor-pointer rounded-md px-4 py-2 font-semibold"
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function displayAnswer(item: QuizItem): string {
  if (item.type === "true_false") return item.answer === "true" ? "True" : "False";
  return item.answer;
}
