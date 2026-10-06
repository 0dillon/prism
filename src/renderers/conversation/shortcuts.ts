"use client";

import { useEffect, useRef } from "react";
import type { SessionIntent } from "@/lib/schemas/intents";

/**
 * Keyboard shortcuts for the conversation (PRD 5.6.3, P4-21). They are single keys, so
 * they must not fight anything else that uses keys:
 *
 * - Typing in a field is never interrupted: shortcuts do not run in text fields.
 * - Space is left to buttons and links, which use it.
 * - Nothing runs with Ctrl, Alt or Meta held, which belong to the browser and to screen
 *   readers (whose own commands also use those keys, and whose browse mode keeps letters
 *   for itself, so these only fire when focus is in an application area).
 * - Nothing runs while a dialog is open.
 */

export interface Shortcut {
  /** The key as `event.key` reports it, lower case. */
  key: string;
  /** How it is shown in the help list. */
  label: string;
  description: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: " ", label: "Space", description: "Pause or resume" },
  { key: "r", label: "R", description: "Repeat what Prism just said" },
  { key: "n", label: "N", description: "Next idea" },
  { key: "q", label: "Q", description: "Quiz me" },
  { key: "s", label: "S", description: "Say it in simpler words" },
  { key: "m", label: "M", description: "Start or stop listening" },
  { key: "?", label: "?", description: "Show this list" },
];

const TEXT_TARGET =
  'input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
const SPACE_TARGET =
  'button, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"]';
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export interface ShortcutActions {
  togglePause(): void;
  command(intent: SessionIntent): void;
  toggleListening(): void;
  showHelp(): void;
}

/** What a key press means, or null if it is not ours to handle. Pure, so it can be tested. */
export function interpretKey(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "altKey" | "metaKey" | "repeat" | "defaultPrevented"
  > & {
    target: EventTarget | null;
  },
): Shortcut | null {
  if (event.defaultPrevented || event.repeat) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(TEXT_TARGET)) return null;
  if (target?.closest(OVERLAY)) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const shortcut = SHORTCUTS.find((s) => s.key === key);
  if (!shortcut) return null;
  if (shortcut.key === " " && target?.closest(SPACE_TARGET)) return null;
  return shortcut;
}

export function useConversationShortcuts(actions: ShortcutActions, enabled = true) {
  const latest = useRef(actions);
  useEffect(() => {
    latest.current = actions;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = interpretKey(event);
      if (!shortcut) return;
      event.preventDefault(); // Space would otherwise scroll the page.
      const a = latest.current;
      switch (shortcut.key) {
        case " ":
          return a.togglePause();
        case "r":
          return a.command({ type: "repeat" });
        case "n":
          return a.command({ type: "next" });
        case "q":
          return a.command({ type: "quiz_me" });
        case "s":
          return a.command({ type: "simplify" });
        case "m":
          return a.toggleListening();
        case "?":
          return a.showHelp();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** Keys that are only a modifier or move focus, so they do not count as "the learner is doing something". */
const QUIET_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Escape"]);

/** Calls `onKey` for any key press that should cut the tutor off (barge-in), anywhere on the page. */
export function useBargeInKey(onKey: () => void, enabled = true) {
  const latest = useRef(onKey);
  useEffect(() => {
    latest.current = onKey;
  });
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (QUIET_KEYS.has(event.key)) return;
      latest.current();
    };
    // In the capture phase, so it runs first and the voice stops before anything else happens.
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [enabled]);
}
