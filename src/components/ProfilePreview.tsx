"use client";

import type { RenderProfile } from "@/lib/schemas/render-profile";
import { useProfileStyles } from "@/renderers/shared/useProfileStyles";

const LAYOUT_NOTES: Record<RenderProfile["layout"], string> = {
  reader: "You will read the lesson as a page.",
  cards: "You will see one idea at a time, on cards.",
  conversation: "Prism will talk you through the lesson, and you can answer by voice or by typing.",
  visual:
    "You will see plain-language cards with pictures, captions, and sign clips for key terms.",
};

/**
 * A live sample of what a lesson will look like with the learner's settings (PRD CE-3). It
 * uses the same styling hook as the real renderers, so what the learner sees here is what
 * they get. It is a sample, so nothing in it is interactive.
 */
export function ProfilePreview({ profile }: { profile: RenderProfile }) {
  const styles = useProfileStyles(profile);
  return (
    <section
      aria-labelledby="preview-heading"
      {...styles}
      className="border-line flex flex-col gap-3 rounded-lg border p-5"
    >
      <h2 id="preview-heading" className="text-xl font-semibold">
        Preview
      </h2>
      <p className="text-muted">{LAYOUT_NOTES[profile.layout]}</p>
      <div
        className="bg-surface flex flex-col gap-3 rounded-md p-4"
        style={{ maxWidth: "var(--measure)" }}
      >
        <h3 className="text-lg font-semibold">Evaporation</h3>
        <p>
          The sun warms water in oceans, lakes, and rivers. Some of the water turns into a gas
          called water vapor and rises into the air.
        </p>
        {profile.content.showExamples ? (
          <p>For example, a puddle disappears on a sunny day.</p>
        ) : null}
        <p className="font-medium">What happens to water during evaporation?</p>
        <ul className="flex flex-col gap-2" aria-label="Sample answers">
          {["It turns into vapor", "It turns into ice"].map((answer) => (
            <li key={answer} className="border-line rounded-md border px-3 py-2">
              {answer}
            </li>
          ))}
        </ul>
        {profile.feedback.progressBar ? (
          <p className="text-muted text-sm">Progress: 1 of 5 ideas</p>
        ) : null}
      </div>
    </section>
  );
}
