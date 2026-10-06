"use client";

import { useEffect, useState } from "react";

export type AnnouncePriority = "polite" | "assertive";

type Listener = (message: string, priority: AnnouncePriority) => void;

const listeners = new Set<Listener>();
// Messages sent before <LiveRegions /> has mounted are held and flushed on mount.
let pending: Array<{ message: string; priority: AnnouncePriority }> = [];

/**
 * Announce a message to screen readers through the global live regions.
 * Callable from any client component or store action. Use "assertive" only for
 * errors or time-critical changes; everything else should stay polite.
 */
export function announce(message: string, priority: AnnouncePriority = "polite"): void {
  const text = message.trim();
  if (!text) return;
  if (listeners.size === 0) {
    pending.push({ message: text, priority });
    return;
  }
  for (const listener of listeners) listener(text, priority);
}

// A non-breaking space is appended on alternate repeats so the region's text
// actually changes and the same message is read again.
const REPEAT_SUFFIX = " ";

function nextText(previous: string, message: string): string {
  return previous === message ? message + REPEAT_SUFFIX : message;
}

/**
 * Renders the two persistent live regions. Mount once, in the root layout, so the
 * regions already exist in the accessibility tree before any message is set.
 */
export function LiveRegions() {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  useEffect(() => {
    const listener: Listener = (message, priority) => {
      if (priority === "assertive") setAssertive((previous) => nextText(previous, message));
      else setPolite((previous) => nextText(previous, message));
    };
    listeners.add(listener);
    const queued = pending;
    pending = [];
    for (const { message, priority } of queued) listener(message, priority);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </>
  );
}
