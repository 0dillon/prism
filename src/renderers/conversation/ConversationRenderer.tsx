"use client";

import { RENDERER_HEADING_ATTRIBUTE, type RendererProps } from "../types";

/**
 * Placeholder for the conversation renderer. It shows the current concept and one control so the
 * shared plumbing (registry, switching, focus, session) can be exercised end to end. The
 * real renderer replaces this in Phase 4 and keeps the same props and heading contract.
 */
export default function ConversationRenderer({ graph, session, actions }: RendererProps) {
  const concept = graph.concepts.find((c) => c.id === graph.concepts[session.conceptIndex]?.id);
  return (
    <section aria-labelledby="renderer-heading" data-layout="conversation">
      <h1 id="renderer-heading" tabIndex={-1} {...{ [RENDERER_HEADING_ATTRIBUTE]: "" }}>
        {graph.title}: conversation view
      </h1>
      <p>{concept ? concept.title : "Ready to start"}</p>
      <button type="button" onClick={session.phase === "intro" ? actions.start : actions.next}>
        {session.phase === "intro" ? "Start" : "Next"}
      </button>
    </section>
  );
}
