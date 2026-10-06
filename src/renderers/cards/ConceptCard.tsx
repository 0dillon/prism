"use client";

import { useId, useState } from "react";
import type { Concept } from "@/lib/schemas/knowledge-graph";
import { MarkdownBody } from "../shared/markdown";

interface ConceptCardProps {
  concept: Concept;
  /** "Idea 2 of 6", shown above the title. */
  positionLabel?: string;
  /** The section the concept belongs to, shown beside the position. */
  sectionTitle?: string;
  showExamples: boolean;
  /** Start with the full explanation open. */
  defaultExpanded?: boolean;
}

/**
 * One idea on one card (PRD 5.6.1): the title, a short summary, an example if there is one,
 * and a "More" control that opens the full explanation in place. The control is a real
 * button with `aria-expanded`, and the card is remounted for each concept so it always
 * starts folded.
 */
export function ConceptCard({
  concept,
  positionLabel,
  sectionTitle,
  showExamples,
  defaultExpanded = false,
}: ConceptCardProps) {
  const titleId = useId();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const example = showExamples ? concept.examples[0] : undefined;
  const hasBody = concept.body.trim().length > 0 && concept.body.trim() !== concept.summary.trim();

  return (
    <article
      aria-labelledby={titleId}
      data-card-focus=""
      tabIndex={-1}
      className="border-line bg-background flex min-h-[55vh] flex-col gap-5 rounded-xl border p-6 outline-none sm:p-8"
    >
      {positionLabel || sectionTitle ? (
        <p className="text-muted text-sm">
          {[positionLabel, sectionTitle].filter(Boolean).join(" · ")}
        </p>
      ) : null}

      <h2 id={titleId} className="text-3xl font-bold">
        {concept.title}
      </h2>

      <p className="text-xl">{concept.summary}</p>

      {concept.keyTerm && concept.definition ? (
        <p className="border-line rounded-md border-s-4 ps-4">
          <span className="font-semibold">{concept.keyTerm}</span>
          {": "}
          {concept.definition}
        </p>
      ) : null}

      {example ? (
        <div className="bg-surface rounded-md p-4">
          <p className="font-semibold">For example</p>
          <p>{example}</p>
        </div>
      ) : null}

      {hasBody ? (
        <div className="mt-auto flex flex-col gap-3">
          <div>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              // The visible word comes first, so the name contains the label (WCAG 2.5.3).
              aria-label={`${expanded ? "Less" : "More"} about ${concept.title}`}
              onClick={() => setExpanded((open) => !open)}
              className="border-line bg-background text-foreground min-h-11 min-w-11 cursor-pointer rounded-md border px-4 py-2 font-semibold"
            >
              {expanded ? "Less" : "More"}
            </button>
          </div>
          <div id={bodyId} hidden={!expanded}>
            <MarkdownBody markdown={concept.body} />
          </div>
        </div>
      ) : null}
    </article>
  );
}
