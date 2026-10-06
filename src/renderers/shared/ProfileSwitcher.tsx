"use client";

import { PRESET_DESCRIPTIONS, PRESET_NAMES } from "@/lib/profile/presets";
import type { RenderProfile } from "@/lib/schemas/render-profile";

type PresetName = (typeof PRESET_NAMES)[number];

interface ProfileSwitcherProps {
  profile: RenderProfile;
  onSelect: (preset: PresetName) => void;
}

/**
 * Preset buttons for changing how the lesson looks, available in every renderer (PRD 5.6).
 * Each is a toggle button, so the current choice is announced, and choosing one is an
 * explicit press, never a side effect of moving focus. Presets are named for what they
 * feel like and never for a condition, and any learner can use any of them.
 */
export function ProfileSwitcher({ profile, onSelect }: ProfileSwitcherProps) {
  return (
    <div role="group" aria-labelledby="profile-switcher-label" className="flex flex-col gap-2">
      <p id="profile-switcher-label" className="font-medium">
        How this lesson looks
      </p>
      <ul className="flex flex-wrap gap-2">
        {PRESET_NAMES.map((preset) => {
          const current = profile.preset === preset;
          return (
            <li key={preset}>
              <button
                type="button"
                aria-pressed={current}
                title={PRESET_DESCRIPTIONS[preset].summary}
                onClick={() => onSelect(preset)}
                className={`min-h-11 min-w-11 cursor-pointer rounded-md border px-4 py-2 font-semibold ${
                  current
                    ? "bg-accent text-accent-foreground border-transparent"
                    : "bg-background border-line"
                }`}
              >
                {PRESET_DESCRIPTIONS[preset].label}
                {current ? <span className="sr-only"> (current)</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      {profile.preset === "custom" ? (
        <p className="text-muted text-sm">Your own settings are in use.</p>
      ) : null}
    </div>
  );
}
