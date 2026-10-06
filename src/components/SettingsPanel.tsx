"use client";

import { Dialog } from "radix-ui";
import { useId, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { Button } from "@/components/Button";
import { SelectField } from "@/components/SelectField";
import { announce } from "@/lib/a11y/live-region";
import type { ProfilePatch } from "@/lib/profile/merge";
import { PRESET_DESCRIPTIONS } from "@/lib/profile/presets";
import { getProfileStore, useProfile, type ProfileStore } from "@/lib/profile/store";
import type { Layout, RenderProfile } from "@/lib/schemas/render-profile";
import { ProfileSwitcher } from "@/renderers/shared/ProfileSwitcher";

interface SettingsPanelProps {
  profileStore?: StoreApi<ProfileStore>;
  /** Start with the dialog open. Used by tests. */
  defaultOpen?: boolean;
}

type Group = "content" | "quiz" | "typography" | "audio" | "visual" | "feedback";

/**
 * Every Render Profile setting, grouped as Content, Quiz, Text, Audio, Visual and
 * Feedback (PRD CE-3, P3-13). Changes apply live as controls move, so the lesson behind
 * the dialog shows the effect straight away. Each control carries `data-setting`, which
 * the tests use to check that no setting in the schema is left out.
 */
export function SettingsPanel({
  profileStore = getProfileStore(),
  defaultOpen,
}: SettingsPanelProps) {
  const profile = useProfile((state) => state.profile, profileStore);
  const id = useId();

  const patch = (change: ProfilePatch, key: string) => {
    try {
      profileStore.getState().applyPatch(change, { coalesceKey: key });
    } catch {
      // The controls only offer valid values, so a rejected change leaves things as they were.
    }
  };

  const set = <G extends Group>(group: G, key: keyof RenderProfile[G] & string, value: unknown) =>
    patch({ [group]: { [key]: value } } as ProfilePatch, `${group}.${key}`);

  // Small builders keep each control's label, hint and data-setting in one place.
  const select = <G extends Group>(
    group: G,
    key: keyof RenderProfile[G] & string,
    label: string,
    options: { value: string; label: string }[],
  ) => (
    <SelectField
      label={label}
      data-setting={`${group}.${key}`}
      value={String(profile[group][key as keyof RenderProfile[G]])}
      options={options}
      onChange={(event) => set(group, key, event.target.value)}
    />
  );

  const check = <G extends Group>(
    group: G,
    key: keyof RenderProfile[G] & string,
    label: string,
    hint?: string,
  ) => (
    <label className="flex min-h-11 items-start gap-3 py-1">
      <input
        type="checkbox"
        data-setting={`${group}.${key}`}
        checked={Boolean(profile[group][key as keyof RenderProfile[G]])}
        onChange={(event) => set(group, key, event.target.checked)}
        className="mt-0.5 size-6"
      />
      <span className="flex flex-col">
        <span className="font-medium">{label}</span>
        {hint ? <span className="text-muted text-sm">{hint}</span> : null}
      </span>
    </label>
  );

  const range = <G extends Group>(
    group: G,
    key: keyof RenderProfile[G] & string,
    label: string,
    bounds: { min: number; max: number; step: number },
    format: (value: number) => string,
  ) => {
    const value = Number(profile[group][key as keyof RenderProfile[G]]);
    const text = format(value);
    return (
      <div className="flex flex-col gap-1">
        <label
          htmlFor={`${id}-${group}-${key}`}
          className="flex items-baseline justify-between gap-4 font-medium"
        >
          <span>{label}</span>
          <span className="text-muted font-normal" aria-hidden="true">
            {text}
          </span>
        </label>
        <input
          id={`${id}-${group}-${key}`}
          type="range"
          data-setting={`${group}.${key}`}
          min={bounds.min}
          max={bounds.max}
          step={bounds.step}
          value={value}
          aria-valuetext={text}
          onChange={(event) => set(group, key, Number(event.target.value))}
          className="h-11 w-full"
        />
      </div>
    );
  };

  const section = (title: string, children: ReactNode) => (
    <fieldset className="border-line flex flex-col gap-4 rounded-lg border p-4">
      <legend className="px-2 text-lg font-semibold">{title}</legend>
      {children}
    </fieldset>
  );

  const percent = (v: number) => `${Math.round(v * 100)}%`;
  const em = (v: number) => `${v.toFixed(2)} em`;

  return (
    <Dialog.Root defaultOpen={defaultOpen}>
      <Dialog.Trigger asChild>
        <Button variant="secondary">Settings</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="bg-background text-foreground border-line fixed top-1/2 left-1/2 z-50 flex max-h-[90vh] w-[min(95vw,40rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border p-6 shadow-xl">
          <Dialog.Title className="text-2xl font-semibold">Settings</Dialog.Title>
          <Dialog.Description className="text-muted">
            Changes apply straight away. Nothing here is a diagnosis; these are just your
            preferences.
          </Dialog.Description>

          {section(
            "Layout",
            <>
              <ProfileSwitcher
                profile={profile}
                onSelect={(preset) => {
                  profileStore.getState().applyPreset(preset);
                  announce(`${PRESET_DESCRIPTIONS[preset].label} selected.`);
                }}
              />
              <SelectField
                label="Layout"
                data-setting="layout"
                value={profile.layout}
                options={[
                  { value: "reader", label: "Reading page" },
                  { value: "cards", label: "Cards" },
                  { value: "conversation", label: "Conversation" },
                  { value: "visual", label: "Pictures and signs" },
                ]}
                onChange={(event) => patch({ layout: event.target.value as Layout }, "layout")}
              />
            </>,
          )}

          {section(
            "Content",
            <>
              {select("content", "readingLevel", "Wording", [
                { value: "original", label: "Original wording" },
                { value: "plain", label: "Plainer wording" },
                { value: "simple", label: "Very simple wording" },
              ])}
              {select("content", "chunkSize", "How much at a time", [
                { value: "concept", label: "One idea at a time" },
                { value: "section", label: "One section at a time" },
                { value: "full", label: "The whole lesson" },
              ])}
              {check("content", "showExamples", "Show examples")}
            </>,
          )}

          {section(
            "Quiz",
            <>
              {range(
                "quiz",
                "cadence",
                "A quiz after every",
                { min: 1, max: 10, step: 1 },
                (v) => `${v} ${v === 1 ? "idea" : "ideas"}`,
              )}
              {range(
                "quiz",
                "itemsPerCheck",
                "Questions in each quiz",
                { min: 1, max: 5, step: 1 },
                String,
              )}
              {check("quiz", "retryOnWrong", "Try again after a wrong answer")}
            </>,
          )}

          {section(
            "Text",
            <>
              {select("typography", "font", "Font", [
                { value: "system", label: "Your device's font" },
                { value: "atkinson", label: "Atkinson Hyperlegible" },
                { value: "lexend", label: "Lexend" },
                { value: "opendyslexic", label: "OpenDyslexic" },
              ])}
              {range(
                "typography",
                "sizeScale",
                "Text size",
                { min: 0.8, max: 2.5, step: 0.05 },
                percent,
              )}
              {range(
                "typography",
                "letterSpacing",
                "Space between letters",
                { min: 0, max: 0.3, step: 0.01 },
                em,
              )}
              {range(
                "typography",
                "wordSpacing",
                "Space between words",
                { min: 0, max: 0.6, step: 0.02 },
                em,
              )}
              {range(
                "typography",
                "lineHeight",
                "Space between lines",
                { min: 1.2, max: 2.4, step: 0.1 },
                (v) => v.toFixed(1),
              )}
              {range(
                "typography",
                "maxLineLength",
                "Line length",
                { min: 30, max: 90, step: 5 },
                (v) => `${v} characters`,
              )}
              {check(
                "typography",
                "wordAnchors",
                "Bold the start of each word",
                "Some people find this helps. Research on it is limited, so it is off unless you choose it.",
              )}
            </>,
          )}

          {section(
            "Audio",
            <>
              {check("audio", "readAloud", "Read the lesson aloud")}
              {select("audio", "syncHighlight", "Highlight while reading aloud", [
                { value: "off", label: "Do not highlight" },
                { value: "sentence", label: "Highlight each sentence" },
                { value: "word", label: "Highlight each word" },
              ])}
              {range("audio", "rate", "Speaking speed", { min: 0.5, max: 3, step: 0.1 }, percent)}
              {check("audio", "voiceInput", "Answer and give commands by voice")}
              {check("audio", "earcons", "Short sounds for listening, correct and wrong")}
            </>,
          )}

          {section(
            "Visual",
            <>
              {select("visual", "theme", "Colors", [
                { value: "system", label: "Match my device" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
                { value: "high_contrast", label: "High contrast" },
                { value: "cream", label: "Cream" },
                { value: "blue_tint", label: "Blue tint" },
              ])}
              {check("visual", "reducedMotion", "Reduce motion")}
              {check("visual", "captions", "Show captions")}
              {check(
                "visual",
                "signClips",
                "Show sign clips for key terms",
                "Signs are shown for key terms. This is not a full translation.",
              )}
              {select("visual", "signLanguage", "Sign language", [
                { value: "ase", label: "American Sign Language (ASL)" },
              ])}
              {check("visual", "conceptImages", "Show pictures")}
            </>,
          )}

          {section(
            "Feedback",
            <>
              {check("feedback", "progressBar", "Show my progress")}
              {check("feedback", "streaks", "Show my streak")}
              {select("feedback", "celebration", "When I get one right", [
                { value: "none", label: "No celebration" },
                { value: "subtle", label: "A small celebration" },
                { value: "full", label: "A big celebration" },
              ])}
              {check("feedback", "haptics", "Vibrate on a phone")}
            </>,
          )}

          <div className="flex justify-end">
            <Dialog.Close asChild>
              <Button>Done</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
