"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SelectField } from "@/components/SelectField";
import { TextArea } from "@/components/TextArea";
import { TextField } from "@/components/TextField";
import { convertQuizType, quizItemProblems, type QuizItemPatch } from "@/lib/ai/ingestion/review";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";

const TYPE_OPTIONS = [
  { value: "mcq", label: "Multiple choice" },
  { value: "true_false", label: "True or false" },
  { value: "short_answer", label: "Short answer" },
];

const DIFFICULTY_OPTIONS = [
  { value: "recall", label: "Recall: the answer is stated in the lesson" },
  { value: "apply", label: "Apply: the learner uses the idea" },
];

const MIN_OPTIONS = 3;
const MAX_OPTIONS = 4;

interface QuizEditorProps {
  item: QuizItem;
  position: number;
  total: number;
  onChange: (patch: QuizItemPatch) => void;
  onDelete: () => void;
}

export function QuizEditor({ item, position, total, onChange, onDelete }: QuizEditorProps) {
  const problems = quizItemProblems(item);
  const options = item.options ?? [];
  const correctIndex = options.indexOf(item.answer);
  const headingId = `quiz-${item.id}-heading`;

  // Kept as raw text so typing a new line does not get swallowed while editing.
  const [acceptableText, setAcceptableText] = useState(item.acceptable.join("\n"));

  const setOption = (index: number, text: string) => {
    const next = [...options];
    next[index] = text;
    // If the correct option is being renamed, the answer follows it.
    onChange({ options: next, answer: index === correctIndex ? text : item.answer });
  };

  const removeOption = (index: number) => {
    const next = options.filter((_, i) => i !== index);
    onChange({ options: next, answer: index === correctIndex ? (next[0] ?? "") : item.answer });
  };

  return (
    <section
      aria-labelledby={headingId}
      className="border-line flex flex-col gap-4 rounded-md border p-4"
    >
      <h4 id={headingId} tabIndex={-1} className="text-lg font-semibold">
        Question {position} of {total}
      </h4>

      <SelectField
        label="Question type"
        value={item.type}
        options={TYPE_OPTIONS}
        onChange={(event) =>
          onChange(convertQuizType(item, event.target.value as QuizItem["type"]))
        }
      />

      <TextArea
        label="Question"
        value={item.prompt}
        error={problems.prompt}
        onChange={(event) => onChange({ prompt: event.target.value })}
      />

      {item.type === "mcq" ? (
        <fieldset className="flex flex-col gap-3">
          <legend className="font-medium">Answer options</legend>
          <p className="text-muted text-sm">
            Write 3 or 4 options and select the one that is correct.
          </p>
          {options.map((option, index) => (
            <div key={index} className="flex flex-wrap items-end gap-3">
              <label className="flex min-h-11 items-center gap-2">
                <input
                  type="radio"
                  name={`correct-${item.id}`}
                  checked={index === correctIndex}
                  onChange={() => onChange({ answer: option })}
                  aria-label={`Option ${index + 1} is the correct answer`}
                  className="size-6"
                />
                <span className="text-sm">Correct</span>
              </label>
              <div className="min-w-48 flex-1">
                <TextField
                  label={`Option ${index + 1}`}
                  value={option}
                  error={problems.options?.[index]}
                  onChange={(event) => setOption(index, event.target.value)}
                />
              </div>
              {options.length > MIN_OPTIONS ? (
                <Button
                  variant="secondary"
                  aria-label={`Remove option ${index + 1}`}
                  onClick={() => removeOption(index)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
          {problems.optionSet ? (
            <p className="text-danger flex items-start gap-1 text-sm font-medium">
              <span aria-hidden="true">⚠</span>
              <span>{problems.optionSet}</span>
            </p>
          ) : null}
          {problems.answer ? (
            <p className="text-danger flex items-start gap-1 text-sm font-medium">
              <span aria-hidden="true">⚠</span>
              <span>{problems.answer}</span>
            </p>
          ) : null}
          {options.length < MAX_OPTIONS ? (
            <div>
              <Button variant="secondary" onClick={() => onChange({ options: [...options, ""] })}>
                Add option
              </Button>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {item.type === "true_false" ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium">Correct answer</legend>
          {(["true", "false"] as const).map((value) => (
            <label key={value} className="flex min-h-11 items-center gap-2">
              <input
                type="radio"
                name={`tf-${item.id}`}
                checked={item.answer === value}
                onChange={() => onChange({ answer: value })}
                className="size-6"
              />
              <span>{value === "true" ? "True" : "False"}</span>
            </label>
          ))}
          {problems.answer ? (
            <p className="text-danger text-sm font-medium">⚠ {problems.answer}</p>
          ) : null}
        </fieldset>
      ) : null}

      {item.type === "short_answer" ? (
        <>
          <TextField
            label="Model answer"
            value={item.answer}
            error={problems.answer}
            onChange={(event) => onChange({ answer: event.target.value })}
          />
          <TextArea
            label="Other answers to accept"
            hint="One per line. Spelling variations and other correct phrasings."
            value={acceptableText}
            onChange={(event) => {
              setAcceptableText(event.target.value);
              onChange({
                acceptable: event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              });
            }}
          />
        </>
      ) : null}

      <TextArea
        label="Explanation shown after answering"
        value={item.explanation}
        error={problems.explanation}
        onChange={(event) => onChange({ explanation: event.target.value })}
      />

      <SelectField
        label="Difficulty"
        value={item.difficulty}
        options={DIFFICULTY_OPTIONS}
        onChange={(event) => onChange({ difficulty: event.target.value as QuizItem["difficulty"] })}
      />

      <div>
        <ConfirmDialog
          trigger={
            <Button variant="secondary" aria-label={`Delete question ${position}`}>
              Delete question
            </Button>
          }
          title="Delete this question?"
          description="The question is removed from the lesson. You can undo this by not saving, or by adding a new question."
          confirmLabel="Delete question"
          onConfirm={onDelete}
        />
      </div>
    </section>
  );
}
