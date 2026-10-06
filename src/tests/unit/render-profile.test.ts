import { describe, expect, it } from "vitest";
import { RenderProfile } from "@/lib/schemas/render-profile";

const minimal = {
  schemaVersion: 1,
  preset: "standard",
  layout: "reader",
  content: {},
  quiz: {},
  typography: {},
  audio: {},
  visual: {},
  feedback: {},
} as const;

describe("RenderProfile", () => {
  it("fills every default from a minimal profile", () => {
    expect(RenderProfile.parse(minimal)).toEqual({
      schemaVersion: 1,
      preset: "standard",
      layout: "reader",
      content: { readingLevel: "original", chunkSize: "section", showExamples: true },
      quiz: { cadence: 5, itemsPerCheck: 1, retryOnWrong: true },
      typography: {
        font: "system",
        sizeScale: 1,
        letterSpacing: 0,
        wordSpacing: 0,
        lineHeight: 1.5,
        maxLineLength: 70,
        wordAnchors: false,
      },
      audio: { readAloud: false, syncHighlight: "off", rate: 1, voiceInput: false, earcons: false },
      visual: {
        theme: "system",
        reducedMotion: false,
        captions: true,
        signClips: false,
        signLanguage: "ase",
        conceptImages: false,
      },
      feedback: { progressBar: true, streaks: false, celebration: "subtle", haptics: false },
    });
  });

  it("keeps word anchors off by default", () => {
    expect(RenderProfile.parse(minimal).typography.wordAnchors).toBe(false);
  });

  it("keeps explicit values", () => {
    const profile = RenderProfile.parse({ ...minimal, quiz: { cadence: 3 }, layout: "cards" });
    expect(profile.quiz.cadence).toBe(3);
    expect(profile.layout).toBe("cards");
  });

  it.each([
    ["quiz cadence above 10", { quiz: { cadence: 11 } }],
    ["quiz cadence of zero", { quiz: { cadence: 0 } }],
    ["fractional cadence", { quiz: { cadence: 2.5 } }],
    ["size scale below range", { typography: { sizeScale: 0.5 } }],
    ["line height above range", { typography: { lineHeight: 3 } }],
    ["line length below range", { typography: { maxLineLength: 20 } }],
    ["unknown font", { typography: { font: "comic" } }],
    ["speech rate above range", { audio: { rate: 4 } }],
    ["unknown theme", { visual: { theme: "neon" } }],
    ["unsupported sign language", { visual: { signLanguage: "bfi" } }],
    ["unknown celebration level", { feedback: { celebration: "extreme" } }],
  ])("rejects %s", (_name, override) => {
    expect(RenderProfile.safeParse({ ...minimal, ...override }).success).toBe(false);
  });

  it("rejects a wrong schema version, unknown preset and unknown layout", () => {
    expect(RenderProfile.safeParse({ ...minimal, schemaVersion: 2 }).success).toBe(false);
    expect(RenderProfile.safeParse({ ...minimal, preset: "adhd" }).success).toBe(false);
    expect(RenderProfile.safeParse({ ...minimal, layout: "grid" }).success).toBe(false);
  });
});
