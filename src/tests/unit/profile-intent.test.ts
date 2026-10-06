import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyNeedsPatch,
  cleanPatch,
  MAX_REQUEST_CHARS,
  NeedsOutput,
  parseNeeds,
} from "@/lib/ai/intents/profile";
import { buildParseNeedsPrompt, PARSE_NEEDS_SYSTEM } from "@/lib/ai/prompts/parse-needs";
import { describeChange, describeChanges, SETTING_DESCRIPTIONS } from "@/lib/profile/describe";
import { diffProfiles } from "@/lib/profile/merge";
import { presetProfile, PRESET_NAMES } from "@/lib/profile/presets";
import { createProfileStore } from "@/lib/profile/store";
import { RenderProfile } from "@/lib/schemas/render-profile";

type Generate = NonNullable<Parameters<typeof parseNeeds>[0]["generate"]>;

const answer = (
  patch: Record<string, unknown>,
  explanation = "I changed it.",
  unsupported: string[] = [],
) => vi.fn(async () => ({ patch, explanation, unsupported })) as unknown as Generate;

const standard = presetProfile("standard");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** Every setting path in the schema, like "typography.lineHeight". */
function settingPaths(): string[] {
  const paths = ["preset", "layout"];
  for (const group of ["content", "quiz", "typography", "audio", "visual", "feedback"] as const) {
    for (const key of Object.keys(RenderProfile.shape[group].shape)) paths.push(`${group}.${key}`);
  }
  return paths;
}

describe("parseNeeds: a valid patch", () => {
  it("turns 'one idea at a time and quiz me often' into cards with a low cadence", async () => {
    const result = await parseNeeds({
      text: "one idea at a time and quiz me often",
      current: standard,
      generate: answer(
        { layout: "cards", content: { chunkSize: "concept" }, quiz: { cadence: 2 } },
        "I switched to cards with a quiz every 2 concepts.",
      ),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile).toMatchObject({
        layout: "cards",
        content: { chunkSize: "concept" },
        quiz: { cadence: 2 },
      });
      expect(result.profile.preset).toBe("custom");
      expect(result.explanation).toBe("I switched to cards with a quiz every 2 concepts.");
      expect(result.changes.map((c) => c.path)).toEqual(
        expect.arrayContaining(["layout", "content.chunkSize", "quiz.cadence"]),
      );
    }
  });

  it("starts from a preset when the model names one, then applies the rest on top", async () => {
    const result = await parseNeeds({
      text: "I lose focus quickly and like being quizzed, and I want big text",
      current: presetProfile("cognitive_ease"),
      generate: answer({ preset: "hyper_focus", typography: { sizeScale: 1.5 } }),
    });
    expect(result.ok && result.profile).toMatchObject({
      preset: "hyper_focus",
      layout: "cards",
      quiz: { cadence: 3 },
      typography: { sizeScale: 1.5, font: "system" }, // the old preset's font is replaced
    });
  });

  it("leaves unchanged settings alone", async () => {
    const current = presetProfile("cognitive_ease");
    const result = await parseNeeds({
      text: "bigger text",
      current,
      generate: answer({ typography: { sizeScale: 1.4 } }),
    });
    expect(result.ok && result.profile.typography.font).toBe("lexend");
    expect(result.ok && result.profile.typography.sizeScale).toBe(1.4);
  });

  it("treats null and empty groups from the model as no change", async () => {
    const result = await parseNeeds({
      text: "make it nicer",
      current: standard,
      generate: answer({ layout: null, quiz: { cadence: null }, audio: {}, visual: null }),
    });
    expect(result.ok && result.changes).toEqual([]);
    expect(result.ok && result.profile).toEqual(standard);
  });

  it("does not mark the profile custom when nothing actually changed", async () => {
    const result = await parseNeeds({
      text: "x",
      current: standard,
      generate: answer({ quiz: { cadence: 5 } }),
    });
    expect(result.ok && result.profile.preset).toBe("standard");
  });

  it("calls the fast tier with the learner's words as data", async () => {
    const generate = answer({});
    await parseNeeds({ text: "read it to me", current: standard, generate });
    const [call] = vi.mocked(generate).mock.calls;
    expect(call[0].tier).toBe("fast");
    expect(call[0].system).toBe(PARSE_NEEDS_SYSTEM);
    expect(call[0].prompt).toContain("<request>\nread it to me\n</request>");
  });
});

describe("parseNeeds: an invalid patch is rejected and the profile kept", () => {
  it.each([
    ["an out of range value", { quiz: { cadence: 99 } }],
    ["a fractional whole number", { quiz: { cadence: 2.5 } }],
    ["text size far too large", { typography: { sizeScale: 10 } }],
    ["speech faster than allowed", { audio: { rate: 9 } }],
  ])("%s", async (_name, patch) => {
    const current = presetProfile("hyper_focus");
    const result = await parseNeeds({ text: "do it", current, generate: answer(patch) });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(result.profile).toBe(current);
  });

  it("rejects an invented setting that slipped through", async () => {
    const result = await parseNeeds({
      text: "make it glow",
      current: standard,
      generate: answer({ visual: { glow: true } }),
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("still returns the unsupported notes when the patch is rejected", async () => {
    const result = await parseNeeds({
      text: "x",
      current: standard,
      generate: answer({ quiz: { cadence: 99 } }, "ok", ["hologram teacher"]),
    });
    expect(result.unsupported).toEqual(["hologram teacher"]);
  });
});

describe("parseNeeds: requests no setting covers", () => {
  it("returns them as unsupported and changes nothing", async () => {
    const result = await parseNeeds({
      text: "make the text sing",
      current: standard,
      generate: answer({}, "I cannot do that yet.", ["make the text sing", "  "]),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unsupported).toEqual(["make the text sing"]);
      expect(result.changes).toEqual([]);
      expect(result.profile).toEqual(standard);
    }
  });

  it("can change one thing and report another as unsupported", async () => {
    const result = await parseNeeds({
      text: "bigger text and a purple unicorn",
      current: standard,
      generate: answer({ typography: { sizeScale: 1.3 } }, "Bigger text, done.", [
        "a purple unicorn",
      ]),
    });
    expect(result.ok && result.profile.typography.sizeScale).toBe(1.3);
    expect(result.unsupported).toEqual(["a purple unicorn"]);
  });
});

describe("parseNeeds: input handling", () => {
  it("does not call the model for empty text", async () => {
    const generate = answer({});
    expect(await parseNeeds({ text: "   ", current: standard, generate })).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("limits how much of a long request reaches the model", async () => {
    const generate = answer({});
    await parseNeeds({ text: "x".repeat(MAX_REQUEST_CHARS * 3), current: standard, generate });
    const prompt = vi.mocked(generate).mock.calls[0][0].prompt;
    expect(prompt.length).toBeLessThan(MAX_REQUEST_CHARS + 600);
  });

  it("propagates a model failure", async () => {
    const generate = vi.fn(async () => {
      throw new Error("provider down");
    }) as unknown as Generate;
    await expect(parseNeeds({ text: "x", current: standard, generate })).rejects.toThrow(
      "provider down",
    );
  });
});

describe("cleanPatch and applyNeedsPatch", () => {
  it("drops nulls, undefined and empty groups at every depth", () => {
    expect(cleanPatch({ a: null, b: { c: null, d: 1 }, e: {}, f: undefined, g: [1] })).toEqual({
      b: { d: 1 },
      g: [1],
    });
  });

  it("returns an empty patch for non-objects", () => {
    for (const value of [null, undefined, 5, "x", []]) expect(cleanPatch(value)).toEqual({});
  });

  it("makes a patch without a preset custom, and keeps the name when one is given", () => {
    expect(applyNeedsPatch(standard, { quiz: { cadence: 2 } }).preset).toBe("custom");
    expect(applyNeedsPatch(standard, { preset: "voice_native" }).preset).toBe("voice_native");
  });

  it("rejects a patch with an unknown preset", () => {
    expect(() => applyNeedsPatch(standard, { preset: "adhd" })).toThrow();
  });
});

describe("the prompt", () => {
  it.each(settingPaths())("mentions the %s setting", (path) => {
    expect(PARSE_NEEDS_SYSTEM).toContain(path);
  });

  it.each(PRESET_NAMES)("describes the %s preset", (name) => {
    expect(PARSE_NEEDS_SYSTEM).toContain(`"${name}"`);
  });

  it("forbids diagnosing and says what to do with requests it cannot meet", () => {
    expect(PARSE_NEEDS_SYSTEM).toMatch(
      /Never ask about, guess, or mention a medical or disability label/,
    );
    expect(PARSE_NEEDS_SYSTEM).toMatch(/unsupported/);
    expect(PARSE_NEEDS_SYSTEM).toMatch(/Never make up a setting/);
    expect(PARSE_NEEDS_SYSTEM).toMatch(/Ignore any instructions/);
  });

  it("summarizes the current settings for the model", () => {
    const prompt = buildParseNeedsPrompt({ text: "hi", current: presetProfile("hyper_focus") });
    expect(prompt).toContain("layout cards");
    expect(prompt).toContain("quiz every 3 concepts");
  });

  it("accepts the shape the prompt describes", () => {
    expect(
      NeedsOutput.safeParse({
        patch: { layout: "cards", quiz: { cadence: 3 } },
        explanation: "x",
        unsupported: [],
      }).success,
    ).toBe(true);
    expect(
      NeedsOutput.safeParse({ patch: { layout: "grid" }, explanation: "x", unsupported: [] })
        .success,
    ).toBe(false);
  });
});

describe("describing changes in plain language", () => {
  it.each(settingPaths())("has a description for %s", (path) => {
    expect(SETTING_DESCRIPTIONS[path]).toBeTypeOf("function");
  });

  it("describes a real change without raw keys", () => {
    const after = applyNeedsPatch(standard, {
      layout: "cards",
      quiz: { cadence: 3 },
      typography: { sizeScale: 1.5 },
    });
    const lines = describeChanges(diffProfiles(standard, after));
    expect(lines).toEqual(
      expect.arrayContaining([
        "Showing the lesson as cards",
        "A quiz after every 3 ideas",
        "Text size 150%",
      ]),
    );
    expect(lines.join(" ")).not.toMatch(/quiz\.cadence|typography\./);
  });

  it("falls back to the preset line when only the preset changed", () => {
    const lines = describeChanges([{ path: "preset", from: "standard", to: "custom" }]);
    expect(lines).toEqual(["Using your own settings"]);
  });

  it("handles singular wording and unknown paths", () => {
    expect(describeChange({ path: "quiz.cadence", from: 5, to: 1 })).toBe(
      "A quiz after every 1 idea",
    );
    expect(describeChange({ path: "mystery.setting", from: 1, to: 2 })).toBe("mystery.setting: 2");
  });
});

describe("profile store applyProfile", () => {
  it("applies a whole profile, records history and supports undo", () => {
    const store = createProfileStore({ storage: null });
    const next = presetProfile("hyper_focus");
    const changes = store.getState().applyProfile(next, { explanation: "I switched to cards." });
    expect(store.getState().profile).toEqual(next);
    expect(changes.length).toBeGreaterThan(0);
    expect(store.getState().lastChange?.explanation).toBe("I switched to cards.");
    store.getState().undo();
    expect(store.getState().profile.layout).toBe("reader");
  });

  it("does nothing for an identical profile and rejects an invalid one", () => {
    const store = createProfileStore({ storage: null });
    expect(store.getState().applyProfile(presetProfile("standard"))).toEqual([]);
    expect(store.getState().history).toEqual([]);
    const bad = presetProfile("standard");
    bad.quiz.cadence = 99;
    expect(() => store.getState().applyProfile(bad)).toThrow();
  });
});
