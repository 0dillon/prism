import { z } from "zod";

/**
 * Render Profile schema (PRD 5.3). A learner's presentation preferences.
 * Profiles are preferences, not diagnoses: nothing here records a condition.
 */
export const RenderProfile = z.object({
  schemaVersion: z.literal(1),
  preset: z.enum([
    "standard",
    "voice_native",
    "hyper_focus",
    "cognitive_ease",
    "visual_sign",
    "custom",
  ]),
  layout: z.enum(["reader", "cards", "conversation", "visual"]),
  content: z.object({
    readingLevel: z.enum(["original", "plain", "simple"]).default("original"),
    chunkSize: z.enum(["concept", "section", "full"]).default("section"),
    showExamples: z.boolean().default(true),
  }),
  quiz: z.object({
    cadence: z.number().int().min(1).max(10).default(5), // quiz after every N concepts
    itemsPerCheck: z.number().int().min(1).max(5).default(1),
    retryOnWrong: z.boolean().default(true),
  }),
  typography: z.object({
    font: z.enum(["system", "atkinson", "lexend", "opendyslexic"]).default("system"),
    sizeScale: z.number().min(0.8).max(2.5).default(1),
    letterSpacing: z.number().min(0).max(0.3).default(0), // em
    wordSpacing: z.number().min(0).max(0.6).default(0), // em
    lineHeight: z.number().min(1.2).max(2.4).default(1.5),
    maxLineLength: z.number().int().min(30).max(90).default(70), // characters
    wordAnchors: z.boolean().default(false), // bold the leading letters of each word
  }),
  audio: z.object({
    readAloud: z.boolean().default(false),
    syncHighlight: z.enum(["off", "sentence", "word"]).default("off"),
    rate: z.number().min(0.5).max(3).default(1),
    voiceInput: z.boolean().default(false),
    earcons: z.boolean().default(false), // short non-speech audio cues
  }),
  visual: z.object({
    theme: z
      .enum(["system", "light", "dark", "high_contrast", "cream", "blue_tint"])
      .default("system"),
    reducedMotion: z.boolean().default(false),
    captions: z.boolean().default(true),
    signClips: z.boolean().default(false),
    signLanguage: z.enum(["ase"]).default("ase"), // ISO 639-3; ASL only in v1
    conceptImages: z.boolean().default(false),
  }),
  feedback: z.object({
    progressBar: z.boolean().default(true),
    streaks: z.boolean().default(false),
    celebration: z.enum(["none", "subtle", "full"]).default("subtle"),
    haptics: z.boolean().default(false),
  }),
});
export type RenderProfile = z.infer<typeof RenderProfile>;

export type Preset = RenderProfile["preset"];
export type Layout = RenderProfile["layout"];
