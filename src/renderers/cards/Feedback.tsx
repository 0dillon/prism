"use client";

import { useEffect } from "react";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { pulse } from "../shared/haptics";
import { useReducedMotion } from "../shared/useReducedMotion";

interface FeedbackProps {
  correct: boolean;
  profile: Pick<RenderProfile, "feedback" | "visual">;
}

const BURST_PIECES = 10;

/**
 * The celebration after an answer (PRD 5.6.1). It is decoration and a haptic pulse: the
 * result itself, with its icon and words, is shown and announced by the quiz block, so
 * nothing here is needed to understand the answer.
 *
 * - A wrong answer gets no celebration, only the pulse if haptics are on: the tone stays neutral.
 * - "subtle" is a check mark that eases in once. "full" adds a short burst that moves outward
 *   once and fades. Neither flashes: nothing changes brightness, and each plays one time.
 * - With "Reduce motion" on, in the profile or on the device, a still check mark stands in
 *   and no animation is rendered at all.
 */
export function Feedback({ correct, profile }: FeedbackProps) {
  const reduced = useReducedMotion(profile.visual.reducedMotion);
  const { celebration, haptics } = profile.feedback;

  useEffect(() => {
    if (haptics) pulse(correct ? "correct" : "incorrect");
  }, [correct, haptics]);

  if (!correct || celebration === "none") return null;

  const animated = !reduced;
  const burst = animated && celebration === "full";
  return (
    <div
      aria-hidden="true"
      data-celebration={animated ? celebration : "still"}
      className="relative flex h-20 items-center justify-center"
    >
      <span
        className={`bg-success text-accent-foreground flex size-14 items-center justify-center rounded-full text-3xl font-bold ${
          animated ? "prism-pop" : ""
        }`}
      >
        ✓
      </span>
      {burst
        ? Array.from({ length: BURST_PIECES }, (_, index) => (
            <span
              key={index}
              data-burst=""
              className="prism-burst bg-accent absolute size-2 rounded-full"
              style={{ ["--angle" as string]: `${(360 / BURST_PIECES) * index}deg` }}
            />
          ))
        : null}
    </div>
  );
}
