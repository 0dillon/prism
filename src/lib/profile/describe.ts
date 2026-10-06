import type { ProfileChange } from "./merge";

/**
 * Plain-language descriptions of profile changes, shown to the learner after they describe
 * what they need. Every setting in the Render Profile has an entry (a test checks this),
 * so a change is never shown as a raw key and value.
 */

type Describe = (value: unknown) => string;

const onOff =
  (label: string): Describe =>
  (value) =>
    `${label} ${value ? "on" : "off"}`;
const percent = (value: unknown) => `${Math.round(Number(value) * 100)}%`;

const LAYOUT_NAMES: Record<string, string> = {
  reader: "reading page",
  cards: "cards",
  conversation: "conversation",
  visual: "pictures and signs",
};

const FONT_NAMES: Record<string, string> = {
  system: "your device's font",
  atkinson: "Atkinson Hyperlegible",
  lexend: "Lexend",
  opendyslexic: "OpenDyslexic",
};

const THEME_NAMES: Record<string, string> = {
  system: "match your device",
  light: "light",
  dark: "dark",
  high_contrast: "high contrast",
  cream: "cream",
  blue_tint: "blue tint",
};

export const SETTING_DESCRIPTIONS: Record<string, Describe> = {
  preset: (v) =>
    v === "custom" ? "Using your own settings" : `Starting point: ${String(v).replace(/_/g, " ")}`,
  layout: (v) => `Showing the lesson as ${LAYOUT_NAMES[String(v)] ?? String(v)}`,
  "content.readingLevel": (v) =>
    v === "original"
      ? "Original wording"
      : v === "plain"
        ? "Plainer wording"
        : "Very simple wording",
  "content.chunkSize": (v) =>
    v === "concept"
      ? "One idea at a time"
      : v === "section"
        ? "One section at a time"
        : "The whole lesson at once",
  "content.showExamples": onOff("Examples"),
  "quiz.cadence": (v) => `A quiz after every ${v} ${Number(v) === 1 ? "idea" : "ideas"}`,
  "quiz.itemsPerCheck": (v) => `${v} ${Number(v) === 1 ? "question" : "questions"} per quiz`,
  "quiz.retryOnWrong": (v) =>
    v ? "Another try after a wrong answer" : "No retry after a wrong answer",
  "typography.font": (v) => `Font: ${FONT_NAMES[String(v)] ?? String(v)}`,
  "typography.sizeScale": (v) => `Text size ${percent(v)}`,
  "typography.letterSpacing": (v) => `Letter spacing ${Number(v)} em`,
  "typography.wordSpacing": (v) => `Word spacing ${Number(v)} em`,
  "typography.lineHeight": (v) => `Line spacing ${Number(v)}`,
  "typography.maxLineLength": (v) => `Lines up to ${v} characters`,
  "typography.wordAnchors": onOff("Bold word starts"),
  "audio.readAloud": onOff("Read aloud"),
  "audio.syncHighlight": (v) =>
    v === "off"
      ? "No highlighting while reading aloud"
      : `Highlighting each ${v} while reading aloud`,
  "audio.rate": (v) => `Speaking speed ${percent(v)}`,
  "audio.voiceInput": onOff("Voice input"),
  "audio.earcons": onOff("Sound cues"),
  "visual.theme": (v) => `Colors: ${THEME_NAMES[String(v)] ?? String(v)}`,
  "visual.reducedMotion": (v) => (v ? "Reduced motion" : "Normal motion"),
  "visual.captions": onOff("Captions"),
  "visual.signClips": onOff("Sign clips"),
  "visual.signLanguage": () => "Sign language: ASL",
  "visual.conceptImages": onOff("Pictures"),
  "feedback.progressBar": onOff("Progress bar"),
  "feedback.streaks": onOff("Streak counter"),
  "feedback.celebration": (v) =>
    v === "none" ? "No celebration" : v === "subtle" ? "A small celebration" : "A big celebration",
  "feedback.haptics": onOff("Vibration"),
};

export function describeChange(change: ProfileChange): string {
  const describe = SETTING_DESCRIPTIONS[change.path];
  return describe ? describe(change.to) : `${change.path}: ${String(change.to)}`;
}

/** One line per change, skipping the preset label when something concrete also changed. */
export function describeChanges(changes: ProfileChange[]): string[] {
  const concrete = changes.filter((c) => c.path !== "preset");
  const shown = concrete.length > 0 ? concrete : changes;
  return shown.map(describeChange);
}
