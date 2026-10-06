"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TextArea } from "@/components/TextArea";
import { TextField } from "@/components/TextField";
import { describeLocator, type ConceptPatch, type QuizItemPatch } from "@/lib/ai/ingestion/review";
import type { Concept, QuizItem } from "@/lib/schemas/knowledge-graph";
import { QuizEditor } from "./QuizEditor";

export interface ConceptEditorProps {
  concept: Concept;
  /** 1-based position in the whole lesson, shown in the heading. */
  position: number;
  total: number;
  quizItems: QuizItem[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  canMerge: boolean;
  onPatch: (patch: ConceptPatch) => void;
  onMove: (direction: "up" | "down") => void;
  onMerge: () => void;
  onDelete: () => void;
  onMarkChecked: () => void;
  onQuizChange: (id: string, patch: QuizItemPatch) => void;
  onQuizDelete: (id: string) => void;
  onQuizAdd: () => void;
}

export const conceptHeadingId = (id: string) => `concept-${id}-heading`;
export const moveButtonId = (id: string, direction: "up" | "down") => `move-${direction}-${id}`;

const FLAG_TEXT: Record<string, string> = {
  ungrounded: "Prism could not find support for this in your file. Please check it.",
  low_confidence: "Prism was not sure about this one. Please check it.",
};

export function ConceptEditor({
  concept,
  position,
  total,
  quizItems,
  canMoveUp,
  canMoveDown,
  canMerge,
  onPatch,
  onMove,
  onMerge,
  onDelete,
  onMarkChecked,
  onQuizChange,
  onQuizDelete,
  onQuizAdd,
}: ConceptEditorProps) {
  const headingId = conceptHeadingId(concept.id);
  const attention = concept.flags.filter(
    (flag) => flag === "ungrounded" || flag === "low_confidence",
  );
  const [examplesText, setExamplesText] = useState(concept.examples.join("\n"));

  const titleError = concept.title.trim() ? undefined : "Give this concept a title.";
  const summaryError = concept.summary.trim() ? undefined : "Write a short summary.";
  const bodyError = concept.body.trim() ? undefined : "Explain the idea.";
  const excerpt = concept.source.excerpt.trim();

  return (
    <article
      aria-labelledby={headingId}
      className="border-line flex flex-col gap-5 rounded-lg border p-5"
    >
      <header className="flex flex-col gap-2">
        <h3 id={headingId} tabIndex={-1} className="text-xl font-semibold outline-none">
          {position}. {concept.title || "Untitled concept"}
        </h3>
        <p className="text-muted text-sm">
          Concept {position} of {total}
          {concept.flags.includes("edited") ? " · Edited by you" : ""}
        </p>
        {attention.map((flag) => (
          <p key={flag} className="flex items-start gap-2 font-medium">
            <span aria-hidden="true">⚑</span>
            <span>
              <span className="font-semibold">Needs your attention: </span>
              {FLAG_TEXT[flag]}
            </span>
          </p>
        ))}
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <TextField
            label="Title"
            value={concept.title}
            error={titleError}
            onChange={(event) => onPatch({ title: event.target.value })}
            maxLength={80}
          />
          <TextArea
            label="Summary"
            hint="One or two sentences. Learners see this first."
            value={concept.summary}
            error={summaryError}
            onChange={(event) => onPatch({ summary: event.target.value })}
            maxLength={240}
          />
          <TextArea
            label="Explanation"
            hint="Plain Markdown. Short paragraphs and everyday words work best."
            rows={6}
            value={concept.body}
            error={bodyError}
            onChange={(event) => onPatch({ body: event.target.value })}
          />
          <TextField
            label="Key term (optional)"
            value={concept.keyTerm ?? ""}
            onChange={(event) => onPatch({ keyTerm: event.target.value || undefined })}
          />
          <TextField
            label="Definition (optional)"
            value={concept.definition ?? ""}
            onChange={(event) => onPatch({ definition: event.target.value || undefined })}
          />
          <TextArea
            label="Examples (optional)"
            hint="One per line."
            value={examplesText}
            onChange={(event) => {
              setExamplesText(event.target.value);
              onPatch({
                examples: event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              });
            }}
          />
        </div>

        <aside aria-label={`Source for concept ${position}`} className="flex flex-col gap-3">
          <h4 className="font-medium">From your file</h4>
          {excerpt ? (
            <blockquote className="bg-surface border-line rounded-md border-l-4 p-4">
              <p>{excerpt}</p>
              <footer className="text-muted mt-2 text-sm">{describeLocator(concept.source)}</footer>
            </blockquote>
          ) : (
            <p className="text-muted">
              This concept has no source passage because you added it yourself.
            </p>
          )}
          {attention.length > 0 ? (
            <div>
              <Button variant="secondary" onClick={onMarkChecked}>
                Mark as checked
              </Button>
            </div>
          ) : null}
        </aside>
      </div>

      <div
        className="flex flex-wrap gap-3"
        role="group"
        aria-label={`Actions for concept ${position}`}
      >
        <Button
          id={moveButtonId(concept.id, "up")}
          variant="secondary"
          disabled={!canMoveUp}
          aria-label={`Move up: concept ${position}, ${concept.title}`}
          onClick={() => onMove("up")}
        >
          Move up
        </Button>
        <Button
          id={moveButtonId(concept.id, "down")}
          variant="secondary"
          disabled={!canMoveDown}
          aria-label={`Move down: concept ${position}, ${concept.title}`}
          onClick={() => onMove("down")}
        >
          Move down
        </Button>
        {canMerge ? (
          <ConfirmDialog
            trigger={
              <Button variant="secondary" aria-label={`Merge into previous: concept ${position}`}>
                Merge into previous
              </Button>
            }
            title="Merge into the previous concept?"
            description="This concept's explanation and quiz questions move into the one before it, and this concept is removed."
            confirmLabel="Merge"
            onConfirm={onMerge}
          />
        ) : null}
        <ConfirmDialog
          trigger={
            <Button variant="secondary" aria-label={`Delete concept ${position}: ${concept.title}`}>
              Delete concept
            </Button>
          }
          title="Delete this concept?"
          description="The concept and its quiz questions are removed from the lesson. Nothing is lost until you save."
          confirmLabel="Delete concept"
          onConfirm={onDelete}
        />
      </div>

      <section aria-labelledby={`${headingId}-quiz`} className="flex flex-col gap-4">
        <h4 id={`${headingId}-quiz`} className="text-lg font-semibold">
          Quiz questions ({quizItems.length})
        </h4>
        {quizItems.length === 0 ? (
          <p className="text-muted">
            There are no questions for this concept yet. Add at least two, including one multiple
            choice.
          </p>
        ) : null}
        {quizItems.map((item, index) => (
          <QuizEditor
            key={item.id}
            item={item}
            position={index + 1}
            total={quizItems.length}
            onChange={(patch) => onQuizChange(item.id, patch)}
            onDelete={() => onQuizDelete(item.id)}
          />
        ))}
        <div>
          <Button variant="secondary" onClick={onQuizAdd}>
            Add a question
          </Button>
        </div>
      </section>
    </article>
  );
}
