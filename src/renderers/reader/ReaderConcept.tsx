"use client";

import { Button } from "@/components/Button";
import type { ConceptContent } from "./content";
import { RichText } from "./RichText";
import { LEVEL_LABELS, type ReadingLevel, type VariantStatus } from "./useVariants";

interface ReaderConceptProps {
  content: ConceptContent;
  /** `h3` under a section heading, `h2` when the concept has no section. */
  titleTag: "h2" | "h3";
  /** Marks the heading focus moves to when the page changes. */
  focusTarget: boolean;
  anchors: boolean;
  markSentences: boolean;
  activeSentenceId: string | null;
  level: ReadingLevel;
  status: VariantStatus;
  error?: string;
  canSimplify: boolean;
  onSimpler: () => void;
  onOriginal: () => void;
  onRetry: () => void;
}

/**
 * One concept in the reading layout: its title, its text and a "Simpler" control. The text
 * is a real run of paragraphs and lists, and its colours, size and spacing come from the
 * profile through the page's custom properties, so nothing here sets a style of its own.
 */
export function ReaderConcept({
  content,
  titleTag: Title,
  focusTarget,
  anchors,
  markSentences,
  activeSentenceId,
  level,
  status,
  error,
  canSimplify,
  onSimpler,
  onOriginal,
  onRetry,
}: ReaderConceptProps) {
  const { concept } = content;
  const titleId = `reader-title-${concept.id}`;
  const text = (unit: ConceptContent["title"], withAnchors: boolean) => (
    <RichText
      unit={unit}
      anchors={withAnchors}
      markSentences={markSentences}
      activeSentenceId={activeSentenceId}
    />
  );

  return (
    <article aria-labelledby={titleId} data-concept-id={concept.id} className="flex flex-col gap-4">
      <Title
        id={titleId}
        tabIndex={-1}
        {...(focusTarget ? { "data-page-focus": "" } : {})}
        className="text-2xl font-bold outline-none"
      >
        {text(content.title, false)}
      </Title>

      {level !== "original" ? <p className="text-muted text-sm">{LEVEL_LABELS[level]}</p> : null}
      {status === "loading" ? <p role="status">Making this simpler…</p> : null}
      {status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 font-medium">
          <p>{error}</p>
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}

      {content.blocks.map((block) =>
        block.kind === "paragraph" ? (
          <p
            key={block.unit.key}
            className={block.tone === "callout" ? "bg-surface rounded-md p-4" : undefined}
          >
            {text(block.unit, anchors)}
          </p>
        ) : block.ordered ? (
          <ol key={block.key} className="list-decimal ps-6">
            {block.items.map((item) => (
              <li key={item.key}>{text(item, anchors)}</li>
            ))}
          </ol>
        ) : (
          <ul key={block.key} className="list-disc ps-6">
            {block.items.map((item) => (
              <li key={item.key}>{text(item, anchors)}</li>
            ))}
          </ul>
        ),
      )}

      <div className="flex flex-wrap gap-3">
        {canSimplify ? (
          <Button
            variant="secondary"
            onClick={onSimpler}
            disabled={status === "loading"}
            aria-label={`Simpler version of ${concept.title}`}
          >
            Simpler
          </Button>
        ) : null}
        {level !== "original" ? (
          <Button
            variant="secondary"
            onClick={onOriginal}
            aria-label={`Original wording of ${concept.title}`}
          >
            Original
          </Button>
        ) : null}
      </div>
    </article>
  );
}
