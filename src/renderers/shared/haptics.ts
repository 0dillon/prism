/**
 * A short vibration for feedback on phones, through the Vibration API (PRD 5.6). It is an
 * extra, never the only signal: the result is always shown and announced in words too.
 * Browsers without the API (desktop, iOS Safari) do nothing.
 */

/** A single short pulse for right, two quick ones for not quite, so they can be told apart by feel. */
const PATTERNS = { correct: [40], incorrect: [30, 60, 30] } as const;

export type HapticKind = keyof typeof PATTERNS;

export function pulse(
  kind: HapticKind,
  nav: Pick<Navigator, "vibrate"> | undefined = defaultNavigator(),
): boolean {
  try {
    if (!nav || typeof nav.vibrate !== "function") return false;
    return nav.vibrate([...PATTERNS[kind]]);
  } catch {
    return false;
  }
}

function defaultNavigator(): Navigator | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}
