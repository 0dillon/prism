"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(QUERY);
  list.addEventListener?.("change", onChange);
  return () => list.removeEventListener?.("change", onChange);
}

function systemPrefersReduced(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * True when motion should be left out: the learner turned on "Reduce motion" in their
 * profile, or their device asks for it. Either one is enough. The stylesheet already
 * shortens animations in both cases; this lets a component skip the animated markup
 * altogether and show a still alternative instead.
 */
export function useReducedMotion(profileFlag: boolean): boolean {
  const system = useSyncExternalStore(subscribe, systemPrefersReduced, () => false);
  return profileFlag || system;
}
