"use client";

import { PRESET_DESCRIPTIONS, PRESET_NAMES } from "@/lib/profile/presets";
import type { RenderProfile } from "@/lib/schemas/render-profile";

interface PresetGalleryProps {
  profile: RenderProfile;
  onSelect: (preset: (typeof PRESET_NAMES)[number]) => void;
}

/**
 * The preset choices for onboarding, each with a plain description of what it feels like
 * (PRD CE-3). Presets are named for experiences, never for conditions, and any learner can
 * pick any of them. Each is a toggle button, so the current choice is announced and
 * nothing happens until it is pressed.
 */
export function PresetGallery({ profile, onSelect }: PresetGalleryProps) {
  return (
    <div role="group" aria-labelledby="preset-gallery-label" className="flex flex-col gap-3">
      <p id="preset-gallery-label" className="text-xl font-semibold">
        Pick a starting point
      </p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {PRESET_NAMES.map((preset) => {
          const current = profile.preset === preset;
          const descriptionId = `preset-${preset}-description`;
          return (
            <li key={preset}>
              <button
                type="button"
                aria-pressed={current}
                aria-describedby={descriptionId}
                onClick={() => onSelect(preset)}
                className={`flex min-h-11 w-full cursor-pointer flex-col gap-1 rounded-lg border-2 p-4 text-start ${
                  current ? "border-accent bg-surface" : "border-line bg-background"
                }`}
              >
                <span className="text-lg font-semibold">
                  {PRESET_DESCRIPTIONS[preset].label + (current ? " (selected)" : "")}
                  {current ? <span aria-hidden="true"> ✓</span> : null}
                </span>
              </button>
              <p id={descriptionId} className="text-muted mt-1 px-1 text-sm">
                {PRESET_DESCRIPTIONS[preset].summary}
              </p>
            </li>
          );
        })}
      </ul>
      {profile.preset === "custom" ? (
        <p className="text-muted">
          You are using your own settings. Pick a starting point to begin again.
        </p>
      ) : null}
    </div>
  );
}
