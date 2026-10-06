"use client";

import { useEffect, useRef, type PointerEvent } from "react";

/** The ways a learner can move between cards (PRD 5.6.1). All of them end in `onNext` or `onPrevious`. */
interface CardInputOptions {
  /** Only act while a card is showing. Quiz and summary screens turn it off. */
  enabled: boolean;
  onNext: () => void;
  onPrevious: () => void;
}

const SWIPE_DISTANCE = 50; // px
const TAP_SLOP = 10; // px a finger may move and still be a tap

const INTERACTIVE =
  'button, a[href], input, select, textarea, summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"]';
// Controls that use the arrow keys themselves. A plain button or link does not, so the
// arrows still turn the card after the learner has clicked Next.
const USES_ARROWS =
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="radio"], [role="tab"], [role="tablist"], [role="menuitem"], [role="listbox"], [role="option"], [role="spinbutton"], [role="textbox"], [role="combobox"], [role="radiogroup"]';
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** True if the event came from a control, which handles its own taps and its Space key. */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE) !== null;
}

/** True if the control uses the arrow keys itself, such as a text field or a slider. */
export function usesArrowKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(USES_ARROWS) !== null;
}

function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY) !== null;
}

/**
 * Keys, swipes and taps for a stack of cards. Returns pointer handlers for the card's
 * container; the keys are listened for on the document so they work without first
 * clicking into the card.
 *
 * - Right arrow and Space go on. Left arrow goes back. Space is left alone when focus is
 *   on a button, link or field, since they use it. The arrows are left alone on text fields,
 *   sliders and the like, which use them, but work after clicking a button. Nothing happens
 *   when a modifier is held or a dialog is open.
 * - A swipe left goes on and a swipe right goes back, when it is mostly sideways.
 * - A tap on the card itself goes on. Taps count only for touch and pen, so clicking to
 *   select text with a mouse never turns the card.
 * - Buttons are always on screen as well, so nothing depends on a gesture (WCAG 2.5.1).
 */
export function useCardInput({ enabled, onNext, onPrevious }: CardInputOptions) {
  const handlers = useRef({ onNext, onPrevious });
  useEffect(() => {
    handlers.current = { onNext, onPrevious };
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (insideOverlay(event.target)) return;
      if (event.key === " " && !isInteractiveTarget(event.target)) {
        event.preventDefault(); // Space would otherwise scroll the page.
        handlers.current.onNext();
      } else if (event.key === "ArrowRight" && !usesArrowKeys(event.target)) {
        event.preventDefault();
        handlers.current.onNext();
      } else if (event.key === "ArrowLeft" && !usesArrowKeys(event.target)) {
        event.preventDefault();
        handlers.current.onPrevious();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled]);

  const start = useRef<{ x: number; y: number; type: string; id: number } | null>(null);

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || isInteractiveTarget(event.target)) {
        start.current = null;
        return;
      }
      start.current = {
        x: event.clientX,
        y: event.clientY,
        type: event.pointerType,
        id: event.pointerId,
      };
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const begin = start.current;
      start.current = null;
      if (!enabled || !begin || begin.id !== event.pointerId) return;
      if (begin.type !== "touch" && begin.type !== "pen") return;
      const dx = event.clientX - begin.x;
      const dy = event.clientY - begin.y;
      if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx < 0) handlers.current.onNext();
        else handlers.current.onPrevious();
      } else if (Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP) {
        handlers.current.onNext();
      }
    },
    onPointerCancel() {
      start.current = null;
    },
  };
}
