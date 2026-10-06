import { RenderProfile, type Preset } from "@/lib/schemas/render-profile";

/**
 * Presets (PRD 5.3). A preset is a named starting Render Profile, named for an
 * experience and never for a condition. Any learner can pick any preset and then change
 * individual settings. Only differences from the defaults are written out.
 */

type Overrides = {
  layout: RenderProfile["layout"];
  content?: Partial<RenderProfile["content"]>;
  quiz?: Partial<RenderProfile["quiz"]>;
  typography?: Partial<RenderProfile["typography"]>;
  audio?: Partial<RenderProfile["audio"]>;
  visual?: Partial<RenderProfile["visual"]>;
  feedback?: Partial<RenderProfile["feedback"]>;
};

const OVERRIDES: Record<Preset, Overrides> = {
  standard: { layout: "reader" },
  // "custom" starts from the standard settings; it is what a profile becomes once a
  // learner changes individual settings.
  custom: { layout: "reader" },
  voice_native: {
    layout: "conversation",
    content: { chunkSize: "concept" },
    quiz: { cadence: 3 },
    audio: { readAloud: true, voiceInput: true, earcons: true },
  },
  hyper_focus: {
    layout: "cards",
    content: { chunkSize: "concept" },
    quiz: { cadence: 3 },
    feedback: { streaks: true, celebration: "full", haptics: true },
  },
  cognitive_ease: {
    layout: "reader",
    content: { readingLevel: "plain" },
    typography: {
      font: "lexend",
      letterSpacing: 0.05,
      wordSpacing: 0.16,
      lineHeight: 1.8,
      maxLineLength: 60,
    },
    audio: { readAloud: true, syncHighlight: "word" },
    visual: { theme: "cream" },
  },
  visual_sign: {
    layout: "visual",
    content: { readingLevel: "plain" },
    audio: { earcons: false },
    visual: { captions: true, signClips: true, conceptImages: true },
    feedback: { haptics: true },
  },
};

export const PRESET_NAMES = [
  "standard",
  "voice_native",
  "hyper_focus",
  "cognitive_ease",
  "visual_sign",
] as const satisfies readonly Preset[];

/** What a learner sees when choosing a preset: what it feels like, not who it is for. */
export const PRESET_DESCRIPTIONS: Record<
  (typeof PRESET_NAMES)[number],
  { label: string; summary: string }
> = {
  standard: {
    label: "Standard",
    summary: "A clear page to read, with a quiz now and then.",
  },
  voice_native: {
    label: "Talk it through",
    summary: "A spoken conversation. Prism reads aloud and you answer by voice or by typing.",
  },
  hyper_focus: {
    label: "One idea at a time",
    summary: "Short cards, a quick quiz every few cards, and a visible streak.",
  },
  cognitive_ease: {
    label: "Easy reading",
    summary: "Roomy spacing, plainer wording, a warm background, and read-aloud with highlighting.",
  },
  visual_sign: {
    label: "Pictures and signs",
    summary: "Plain-language cards with pictures, captions, and sign clips for key terms.",
  },
};

/** A complete, valid profile for a preset, with every default filled in. */
export function presetProfile(preset: Preset): RenderProfile {
  const overrides = OVERRIDES[preset];
  return RenderProfile.parse({
    schemaVersion: 1,
    preset,
    layout: overrides.layout,
    content: overrides.content ?? {},
    quiz: overrides.quiz ?? {},
    typography: overrides.typography ?? {},
    audio: overrides.audio ?? {},
    visual: overrides.visual ?? {},
    feedback: overrides.feedback ?? {},
  });
}

export const DEFAULT_PROFILE: RenderProfile = presetProfile("standard");
