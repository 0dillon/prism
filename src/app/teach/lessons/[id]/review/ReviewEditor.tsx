"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ulid } from "ulid";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import {
  addConcept,
  addQuizItem,
  canMove,
  deleteConcept,
  deleteQuizItem,
  flaggedConceptIds,
  hasProblems,
  markChecked,
  mergeIntoPrevious,
  moveConcept,
  orderedConcepts,
  quizItemProblems,
  quizItemsFor,
  updateConcept,
  updateQuizItem,
  updateSectionTitle,
  type ConceptPatch,
  type Direction,
  type QuizItemPatch,
} from "@/lib/ai/ingestion/review";
import { validateGraph, type ValidationIssue } from "@/lib/ai/ingestion/validate";
import { announce } from "@/lib/a11y/live-region";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { ConceptEditor, conceptHeadingId, moveButtonId } from "./ConceptEditor";

export interface ReviewEditorProps {
  lessonId: string;
  initialGraph: KnowledgeGraph;
  /** The lesson's updated_at when loaded, sent back on save to detect edits made elsewhere. */
  initialUpdatedAt: string;
  /** Override the save call. Used by tests. */
  save?: SaveFn;
}

export type SaveFn = (
  lessonId: string,
  body: { graph: KnowledgeGraph; expectedUpdatedAt: string },
) => Promise<{ graph: KnowledgeGraph; warnings: ValidationIssue[]; updatedAt: string }>;

export class SaveError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
  }
}

const defaultSave: SaveFn = async (lessonId, body) => {
  const response = await fetch(`/api/lessons/${lessonId}/graph`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as
    | { error?: { code?: string; message?: string } }
    | { graph: KnowledgeGraph; warnings: ValidationIssue[]; updatedAt: string }
    | null;
  if (!response.ok) {
    const error = json && "error" in json ? json.error : undefined;
    throw new SaveError(
      error?.message ?? "We could not save your changes.",
      error?.code ?? "unknown",
    );
  }
  return json as { graph: KnowledgeGraph; warnings: ValidationIssue[]; updatedAt: string };
};

type FocusTarget =
  { kind: "move"; id: string; direction: Direction } | { kind: "heading"; id: string } | null;

/** Plain-language problems that stop a save, from the schema and from the quiz item rules. */
function blockingProblems(graph: KnowledgeGraph): string[] {
  const messages: string[] = [];
  for (const concept of graph.concepts) {
    if (!concept.title.trim()) messages.push("A concept has no title.");
    if (!concept.summary.trim())
      messages.push(`"${concept.title || "Untitled concept"}" has no summary.`);
    if (!concept.body.trim())
      messages.push(`"${concept.title || "Untitled concept"}" has no explanation.`);
  }
  for (const item of graph.quizItems) {
    if (hasProblems(quizItemProblems(item))) {
      const concept = graph.concepts.find((c) => c.id === item.conceptId);
      messages.push(`A question in "${concept?.title ?? "a concept"}" needs fixing.`);
    }
  }
  const result = validateGraph(graph);
  if (!result.ok && messages.length === 0)
    messages.push(...result.errors.slice(0, 5).map((e) => e.message));
  return [...new Set(messages)];
}

export function ReviewEditor({
  lessonId,
  initialGraph,
  initialUpdatedAt,
  save = defaultSave,
}: ReviewEditorProps) {
  const [graph, setGraph] = useState(initialGraph);
  const [saved, setSaved] = useState(initialGraph);
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [saving, setSaving] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [saveError, setSaveError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);

  const dirty = useMemo(() => JSON.stringify(graph) !== JSON.stringify(saved), [graph, saved]);
  const concepts = useMemo(() => orderedConcepts(graph), [graph]);
  const flagged = useMemo(() => new Set(flaggedConceptIds(graph)), [graph]);
  const needAttention = concepts.filter((c) => flagged.has(c.id));

  const pendingFocus = useRef<FocusTarget>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const problemsRef = useRef<HTMLDivElement>(null);

  // Apply a queued focus change after the DOM has updated.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target.kind === "move") {
      const wanted = document.getElementById(
        moveButtonId(target.id, target.direction),
      ) as HTMLButtonElement | null;
      const other = document.getElementById(
        moveButtonId(target.id, target.direction === "up" ? "down" : "up"),
      ) as HTMLButtonElement | null;
      const heading = document.getElementById(conceptHeadingId(target.id));
      (wanted && !wanted.disabled ? wanted : other && !other.disabled ? other : heading)?.focus();
    } else {
      (document.getElementById(conceptHeadingId(target.id)) ?? summaryRef.current)?.focus();
    }
  }, [graph]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const titleOf = (id: string) => graph.concepts.find((c) => c.id === id)?.title ?? "concept";

  const onMove = (id: string, direction: Direction) => {
    const title = titleOf(id);
    const next = moveConcept(graph, id, direction);
    const position = orderedConcepts(next).findIndex((c) => c.id === id) + 1;
    pendingFocus.current = { kind: "move", id, direction };
    setGraph(next);
    announce(
      `Moved ${title} ${direction}. It is now concept ${position} of ${next.concepts.length}.`,
    );
  };

  const onDelete = (id: string) => {
    const title = titleOf(id);
    const index = concepts.findIndex((c) => c.id === id);
    const neighbor = concepts[index + 1] ?? concepts[index - 1];
    pendingFocus.current = neighbor
      ? { kind: "heading", id: neighbor.id }
      : { kind: "heading", id: "" };
    setGraph(deleteConcept(graph, id));
    announce(`Deleted ${title}.`);
  };

  const onMerge = (id: string) => {
    const index = concepts.findIndex((c) => c.id === id);
    const keeper = concepts[index - 1];
    pendingFocus.current = keeper ? { kind: "heading", id: keeper.id } : null;
    setGraph(mergeIntoPrevious(graph, id));
    announce(`Merged ${titleOf(id)} into ${keeper?.title ?? "the previous concept"}.`);
  };

  const onSave = async () => {
    const blocking = blockingProblems(graph);
    setProblems(blocking);
    setSaveError(null);
    if (blocking.length > 0) {
      announce("Fix the problems listed before saving.", "assertive");
      requestAnimationFrame(() => problemsRef.current?.focus());
      return;
    }

    setSaving(true);
    try {
      const result = await save(lessonId, { graph, expectedUpdatedAt: updatedAt });
      setGraph(result.graph);
      setSaved(result.graph);
      setUpdatedAt(result.updatedAt);
      setWarnings(result.warnings);
      announce("Changes saved.");
    } catch (error) {
      const conflict = error instanceof SaveError && error.code === "conflict";
      const message = error instanceof Error ? error.message : "We could not save your changes.";
      setSaveError({ message, conflict });
      announce(`Not saved. ${message}`, "assertive");
      requestAnimationFrame(() => problemsRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  const renderConcept = (conceptId: string) => {
    const concept = graph.concepts.find((c) => c.id === conceptId);
    if (!concept) return null;
    const position = concepts.findIndex((c) => c.id === conceptId) + 1;
    return (
      <ConceptEditor
        key={concept.id}
        concept={concept}
        position={position}
        total={concepts.length}
        quizItems={quizItemsFor(graph, concept.id)}
        canMoveUp={canMove(graph, concept.id, "up")}
        canMoveDown={canMove(graph, concept.id, "down")}
        canMerge={position > 1}
        onPatch={(patch: ConceptPatch) => setGraph((g) => updateConcept(g, concept.id, patch))}
        onMove={(direction) => onMove(concept.id, direction)}
        onMerge={() => onMerge(concept.id)}
        onDelete={() => onDelete(concept.id)}
        onMarkChecked={() => {
          setGraph((g) => markChecked(g, concept.id));
          announce(`Marked ${concept.title} as checked.`);
        }}
        onQuizChange={(id, patch: QuizItemPatch) => setGraph((g) => updateQuizItem(g, id, patch))}
        onQuizDelete={(id) => {
          setGraph((g) => deleteQuizItem(g, id));
          announce("Question deleted.");
        }}
        onQuizAdd={() => {
          setGraph((g) => addQuizItem(g, concept.id, `q_${ulid()}`));
          announce("Question added.");
        }}
      />
    );
  };

  const attentionIds = new Set(needAttention.map((c) => c.id));
  const sections = graph.sections;
  const questionCount = graph.quizItems.length;

  return (
    <div className="flex flex-col gap-8">
      <div ref={summaryRef} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        <p>
          {concepts.length} concepts, {questionCount} quiz questions
          {needAttention.length > 0
            ? `, ${needAttention.length} ${needAttention.length === 1 ? "needs" : "need"} your attention`
            : ""}
          .
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Button onClick={() => void onSave()} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <p role="status" className="text-muted">
            {saving
              ? "Saving your changes"
              : dirty
                ? "You have unsaved changes."
                : "All changes saved."}
          </p>
        </div>
      </div>

      {problems.length > 0 || saveError ? (
        <div
          ref={problemsRef}
          tabIndex={-1}
          role="alert"
          className="border-line text-danger flex flex-col gap-2 rounded-md border p-4 font-medium"
        >
          {saveError ? (
            <p>
              <span aria-hidden="true">⚠ </span>
              {saveError.message}
            </p>
          ) : (
            <>
              <p>
                <span aria-hidden="true">⚠ </span>Fix these before saving:
              </p>
              <ul className="list-disc pl-6">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </>
          )}
          {saveError?.conflict ? (
            <div>
              <Button variant="secondary" onClick={() => window.location.reload()}>
                Reload the latest version
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <section aria-labelledby="warnings-heading" className="flex flex-col gap-2">
          <h2 id="warnings-heading" className="text-lg font-semibold">
            Worth a look
          </h2>
          <ul className="list-disc pl-6">
            {warnings.map((warning, index) => (
              <li key={`${warning.path}-${index}`}>{warning.message}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {needAttention.length > 0 ? (
        <section aria-labelledby="attention-heading" className="flex flex-col gap-4">
          <h2 id="attention-heading" className="text-2xl font-semibold">
            Needs your attention
          </h2>
          <p className="text-muted">
            Prism was less sure about these. Check each one against your file, then mark it as
            checked.
          </p>
          {needAttention.map((concept) => renderConcept(concept.id))}
        </section>
      ) : null}

      {sections.map((section) => {
        const inSection = concepts.filter(
          (c) => c.sectionId === section.id && !attentionIds.has(c.id),
        );
        if (inSection.length === 0) return null;
        return (
          <section
            key={section.id}
            aria-labelledby={`section-${section.id}`}
            className="flex flex-col gap-4"
          >
            <h2 id={`section-${section.id}`} className="text-2xl font-semibold">
              {section.title}
            </h2>
            <details>
              <summary className="min-h-11 cursor-pointer py-2 font-medium">
                Rename this section
              </summary>
              <div className="mt-2 max-w-md">
                <TextField
                  label="Section title"
                  value={section.title}
                  onChange={(event) =>
                    setGraph((g) => updateSectionTitle(g, section.id, event.target.value))
                  }
                />
              </div>
            </details>
            {inSection.map((concept) => renderConcept(concept.id))}
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  const id = `c_${ulid()}`;
                  pendingFocus.current = { kind: "heading", id };
                  setGraph((g) => addConcept(g, section.id, id));
                  announce(`Added a new concept to ${section.title}.`);
                }}
              >
                {`Add a concept to ${section.title}`}
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
