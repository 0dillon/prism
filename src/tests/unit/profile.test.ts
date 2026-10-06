import { describe, expect, it } from "vitest";
import {
  deepMergeProfile,
  diffProfiles,
  patchSelectsPreset,
  ProfilePatchError,
} from "@/lib/profile/merge";
import {
  DEFAULT_PROFILE,
  PRESET_DESCRIPTIONS,
  PRESET_NAMES,
  presetProfile,
} from "@/lib/profile/presets";
import { RenderProfile } from "@/lib/schemas/render-profile";

describe("presets", () => {
  it.each(PRESET_NAMES)("%s parses as a complete valid profile", (name) => {
    const profile = presetProfile(name);
    expect(RenderProfile.safeParse(profile).success).toBe(true);
    expect(profile.preset).toBe(name);
  });

  it("standard is the defaults in the reader layout", () => {
    expect(presetProfile("standard")).toEqual({
      ...DEFAULT_PROFILE,
      preset: "standard",
      layout: "reader",
    });
    expect(DEFAULT_PROFILE.typography.font).toBe("system");
    expect(DEFAULT_PROFILE.quiz.cadence).toBe(5);
  });

  it("voice_native matches the PRD table", () => {
    const p = presetProfile("voice_native");
    expect(p.layout).toBe("conversation");
    expect(p.audio).toMatchObject({ readAloud: true, voiceInput: true, earcons: true });
    expect(p.content.chunkSize).toBe("concept");
    expect(p.quiz.cadence).toBe(3);
  });

  it("hyper_focus matches the PRD table", () => {
    const p = presetProfile("hyper_focus");
    expect(p.layout).toBe("cards");
    expect(p.content.chunkSize).toBe("concept");
    expect(p.quiz.cadence).toBe(3);
    expect(p.feedback).toMatchObject({ streaks: true, celebration: "full", haptics: true });
  });

  it("cognitive_ease matches the PRD table", () => {
    const p = presetProfile("cognitive_ease");
    expect(p.layout).toBe("reader");
    expect(p.typography).toMatchObject({
      font: "lexend",
      letterSpacing: 0.05,
      wordSpacing: 0.16,
      lineHeight: 1.8,
      maxLineLength: 60,
    });
    expect(p.audio).toMatchObject({ readAloud: true, syncHighlight: "word" });
    expect(p.visual.theme).toBe("cream");
    expect(p.content.readingLevel).toBe("plain");
  });

  it("visual_sign matches the PRD table", () => {
    const p = presetProfile("visual_sign");
    expect(p.layout).toBe("visual");
    expect(p.visual).toMatchObject({ captions: true, signClips: true, conceptImages: true });
    expect(p.content.readingLevel).toBe("plain");
    expect(p.feedback.haptics).toBe(true);
    expect(p.audio.earcons).toBe(false);
  });

  it("keeps word anchors off in every preset", () => {
    for (const name of [...PRESET_NAMES, "custom" as const]) {
      expect(presetProfile(name).typography.wordAnchors).toBe(false);
    }
  });

  it("never names a condition or a disability", () => {
    const text = JSON.stringify({ PRESET_DESCRIPTIONS, PRESET_NAMES });
    expect(text).not.toMatch(/adhd|dyslex|autis|blind|deaf|disab|condition|diagnos/i);
  });

  it("describes every preset in words a learner can choose between", () => {
    for (const name of PRESET_NAMES) {
      expect(PRESET_DESCRIPTIONS[name].label.length).toBeGreaterThan(2);
      expect(PRESET_DESCRIPTIONS[name].summary.length).toBeGreaterThan(20);
    }
  });

  it("returns a fresh object each time", () => {
    const a = presetProfile("hyper_focus");
    a.quiz.cadence = 9;
    expect(presetProfile("hyper_focus").quiz.cadence).toBe(3);
  });
});

describe("deepMergeProfile", () => {
  const base = presetProfile("standard");

  it("merges a partial patch into one group and leaves the rest alone", () => {
    const next = deepMergeProfile(base, { quiz: { cadence: 2 } });
    expect(next.quiz).toEqual({ ...base.quiz, cadence: 2 });
    expect(next.typography).toEqual(base.typography);
    expect(next.layout).toBe("reader");
  });

  it("can change several groups and the layout at once", () => {
    const next = deepMergeProfile(base, {
      layout: "cards",
      quiz: { cadence: 3 },
      feedback: { streaks: true },
    });
    expect(next).toMatchObject({
      layout: "cards",
      quiz: { cadence: 3 },
      feedback: { streaks: true },
    });
  });

  it("does not mutate the base or the patch", () => {
    const patch = { quiz: { cadence: 2 } };
    const before = JSON.stringify(base);
    deepMergeProfile(base, patch);
    expect(JSON.stringify(base)).toBe(before);
    expect(patch).toEqual({ quiz: { cadence: 2 } });
  });

  it("treats undefined values as no change", () => {
    const next = deepMergeProfile(base, { quiz: { cadence: undefined, itemsPerCheck: 2 } });
    expect(next.quiz.cadence).toBe(5);
    expect(next.quiz.itemsPerCheck).toBe(2);
  });

  it("accepts an empty patch", () => {
    expect(deepMergeProfile(base, {})).toEqual(base);
  });

  it.each([
    ["an out of range number", { quiz: { cadence: 50 } }],
    ["a fractional integer", { quiz: { cadence: 2.5 } }],
    ["a wrong type", { audio: { readAloud: "yes" } }],
    ["an unknown enum value", { visual: { theme: "neon" } }],
    ["an unknown layout", { layout: "grid" }],
    ["an unknown preset", { preset: "adhd" }],
    ["size scale too large", { typography: { sizeScale: 10 } }],
    ["speech rate too fast", { audio: { rate: 9 } }],
  ])("rejects %s", (_name, patch) => {
    expect(() => deepMergeProfile(base, patch)).toThrow(ProfilePatchError);
  });

  it("rejects a setting that does not exist, naming it", () => {
    expect(() => deepMergeProfile(base, { typography: { glow: true } })).toThrow(
      /typography\.glow/,
    );
    expect(() => deepMergeProfile(base, { teleport: true })).toThrow(/"teleport" is not a setting/);
  });

  it("rejects a diagnosis field if one is ever sent", () => {
    expect(() => deepMergeProfile(base, { diagnosis: "x" })).toThrow(ProfilePatchError);
  });

  it.each([null, undefined, 5, "text", [], true])("rejects a patch that is %j", (patch) => {
    expect(() => deepMergeProfile(base, patch)).toThrow(ProfilePatchError);
  });

  it("rejects a group that is not an object", () => {
    expect(() => deepMergeProfile(base, { quiz: 3 })).toThrow(/"quiz" must be an object/);
  });

  it("reports every problem at once", () => {
    try {
      deepMergeProfile(base, { quiz: { cadence: 99 }, nope: 1, audio: { zzz: 1 } });
      expect.unreachable();
    } catch (error) {
      expect((error as ProfilePatchError).problems.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("leaves the caller's profile unchanged when a patch is rejected", () => {
    const before = JSON.stringify(base);
    expect(() => deepMergeProfile(base, { quiz: { cadence: 99 } })).toThrow();
    expect(JSON.stringify(base)).toBe(before);
  });

  it("always returns a profile that passes the schema", () => {
    const next = deepMergeProfile(base, { typography: { font: "opendyslexic", sizeScale: 1.5 } });
    expect(RenderProfile.safeParse(next).success).toBe(true);
  });
});

describe("diffProfiles", () => {
  it("lists changed settings with their old and new values", () => {
    const before = presetProfile("standard");
    const after = deepMergeProfile(before, { layout: "cards", quiz: { cadence: 3 } });
    expect(diffProfiles(before, after)).toEqual([
      { path: "layout", from: "reader", to: "cards" },
      { path: "quiz.cadence", from: 5, to: 3 },
    ]);
  });

  it("is empty for identical profiles", () => {
    expect(diffProfiles(DEFAULT_PROFILE, presetProfile("standard"))).toEqual([]);
  });

  it("describes a whole preset switch", () => {
    const paths = diffProfiles(presetProfile("standard"), presetProfile("hyper_focus")).map(
      (c) => c.path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "preset",
        "layout",
        "content.chunkSize",
        "quiz.cadence",
        "feedback.streaks",
      ]),
    );
  });
});

describe("patchSelectsPreset", () => {
  it("is true only when the patch names a preset", () => {
    expect(patchSelectsPreset({ preset: "hyper_focus" })).toBe(true);
    expect(patchSelectsPreset({ quiz: { cadence: 2 } })).toBe(false);
  });
});
