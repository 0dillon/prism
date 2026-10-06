import { z } from "zod";
import {
  diffProfiles,
  deepMergeProfile,
  ProfilePatchError,
  type ProfileChange,
} from "@/lib/profile/merge";
import { presetProfile, PRESET_NAMES } from "@/lib/profile/presets";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import { generateStructured as defaultGenerate } from "../llm";
import { buildParseNeedsPrompt, PARSE_NEEDS_SYSTEM } from "../prompts/parse-needs";
import type { UsageCallback } from "../usage";

/**
 * Needs to profile (PRD 5.4 A, task P3-10). The model proposes a patch from the learner's
 * words. This code merges it and validates the result as a whole: an invalid proposal is
 * rejected and the learner's current profile is kept.
 */

export const MAX_REQUEST_CHARS = 1000;

/**
 * What the model returns. Fields are all optional and simply left out when unchanged.
 * (Nullable fields are avoided: Gemini rejects schemas that allow null.) cleanPatch still
 * tolerates a null if a model sends one.
 */
const opt = <T extends z.ZodType>(schema: T) => schema.optional();
const whole = z.number();

export const NeedsOutput = z.object({
  patch: z.object({
    preset: opt(z.enum(PRESET_NAMES)),
    layout: opt(z.enum(["reader", "cards", "conversation", "visual"])),
    content: opt(
      z.object({
        readingLevel: opt(z.enum(["original", "plain", "simple"])),
        chunkSize: opt(z.enum(["concept", "section", "full"])),
        showExamples: opt(z.boolean()),
      }),
    ),
    quiz: opt(
      z.object({ cadence: opt(whole), itemsPerCheck: opt(whole), retryOnWrong: opt(z.boolean()) }),
    ),
    typography: opt(
      z.object({
        font: opt(z.enum(["system", "atkinson", "lexend", "opendyslexic"])),
        sizeScale: opt(z.number()),
        letterSpacing: opt(z.number()),
        wordSpacing: opt(z.number()),
        lineHeight: opt(z.number()),
        maxLineLength: opt(whole),
        wordAnchors: opt(z.boolean()),
      }),
    ),
    audio: opt(
      z.object({
        readAloud: opt(z.boolean()),
        syncHighlight: opt(z.enum(["off", "sentence", "word"])),
        rate: opt(z.number()),
        voiceInput: opt(z.boolean()),
        earcons: opt(z.boolean()),
      }),
    ),
    visual: opt(
      z.object({
        theme: opt(z.enum(["system", "light", "dark", "high_contrast", "cream", "blue_tint"])),
        reducedMotion: opt(z.boolean()),
        captions: opt(z.boolean()),
        signClips: opt(z.boolean()),
        conceptImages: opt(z.boolean()),
      }),
    ),
    feedback: opt(
      z.object({
        progressBar: opt(z.boolean()),
        streaks: opt(z.boolean()),
        celebration: opt(z.enum(["none", "subtle", "full"])),
        haptics: opt(z.boolean()),
      }),
    ),
  }),
  explanation: z.string(),
  unsupported: z.array(z.string()),
});
export type NeedsOutput = z.infer<typeof NeedsOutput>;

/** Removes nulls and empty groups so the patch contains only real changes. */
export function cleanPatch(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "object" && !Array.isArray(entry)) {
      const nested = cleanPatch(entry);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else {
      result[key] = entry;
    }
  }
  return result;
}

export type ParseNeedsResult =
  | {
      ok: true;
      /** The learner's new profile. Equal to the current one if nothing changed. */
      profile: RenderProfile;
      changes: ProfileChange[];
      explanation: string;
      /** Requests that no setting covers, for the unmet needs log. */
      unsupported: string[];
    }
  | { ok: false; reason: "empty" | "invalid"; profile: RenderProfile; unsupported: string[] };

/**
 * Applies a cleaned patch to the current profile. Naming a preset starts from that preset
 * and applies the rest on top; adjusting settings alone makes the profile custom.
 */
export function applyNeedsPatch(
  current: RenderProfile,
  patch: Record<string, unknown>,
): RenderProfile {
  const named = patch.preset;
  if (typeof named === "string" && (PRESET_NAMES as readonly string[]).includes(named)) {
    const rest = { ...patch };
    delete rest.preset;
    return deepMergeProfile(presetProfile(named as (typeof PRESET_NAMES)[number]), rest);
  }
  const merged = deepMergeProfile(current, patch);
  const changed = diffProfiles(current, merged).length > 0;
  return changed && merged.preset !== "custom" && patch.preset === undefined
    ? { ...merged, preset: "custom" }
    : merged;
}

type Generate = typeof defaultGenerate;

export async function parseNeeds(options: {
  text: string;
  current: RenderProfile;
  onUsage?: UsageCallback;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}): Promise<ParseNeedsResult> {
  const text = options.text.trim().slice(0, MAX_REQUEST_CHARS);
  if (!text) return { ok: false, reason: "empty", profile: options.current, unsupported: [] };

  const generate = options.generate ?? defaultGenerate;
  const output = await generate({
    schema: NeedsOutput,
    system: PARSE_NEEDS_SYSTEM,
    prompt: buildParseNeedsPrompt({ text, current: options.current }),
    tier: "fast",
    name: "parse-needs",
    onUsage: options.onUsage,
  });

  const unsupported = output.unsupported.map((item) => item.trim()).filter(Boolean);
  try {
    const profile = applyNeedsPatch(options.current, cleanPatch(output.patch));
    return {
      ok: true,
      profile,
      changes: diffProfiles(options.current, profile),
      explanation: output.explanation.trim(),
      unsupported,
    };
  } catch (error) {
    if (error instanceof ProfilePatchError) {
      // The model proposed something out of range or invented a setting. Keep what the learner has.
      return { ok: false, reason: "invalid", profile: options.current, unsupported };
    }
    throw error;
  }
}
