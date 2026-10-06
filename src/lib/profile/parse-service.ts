import { z } from "zod";
import type { UserClient } from "@/lib/api/http";
import { parseNeeds, MAX_REQUEST_CHARS, type ParseNeedsResult } from "@/lib/ai/intents/profile";
import { generateStructured as defaultGenerate } from "@/lib/ai/llm";
import { logger } from "@/lib/log";
import { RenderProfile } from "@/lib/schemas/render-profile";
import { describeChanges } from "./describe";

/**
 * "Tell Prism what you need" (PRD 5.4 A, 7.5): the learner's words in, a validated new
 * profile out. Signed-out visitors can use it too, so the profile they build before
 * signing up is theirs to keep.
 */

export const ParseNeedsInput = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Tell Prism what would help.")
    .max(MAX_REQUEST_CHARS, `Please use ${MAX_REQUEST_CHARS} characters or fewer.`),
  profile: RenderProfile,
});
export type ParseNeedsInput = z.infer<typeof ParseNeedsInput>;

export type ParseNeedsResponse =
  | {
      ok: true;
      profile: RenderProfile;
      /** What changed, in plain language. Empty if nothing did. */
      changes: string[];
      explanation: string;
      unsupported: string[];
    }
  | { ok: false; message: string; unsupported: string[] };

const NOTHING_CHANGED = "I could not find a setting for that, so nothing changed.";

/** Records requests that no setting covers, to guide the roadmap. Failure to log never fails the request. */
export async function logUnmetNeeds(
  admin: UserClient,
  userId: string | null,
  items: string[],
): Promise<void> {
  if (items.length === 0) return;
  const rows = items.slice(0, 10).map((item) => ({
    user_id: userId,
    request_text: item.slice(0, 500),
  }));
  const { error } = await admin.from("unmet_needs").insert(rows);
  if (error) logger.warn("could not log unmet needs", { error: error.message });
}

export async function parseNeedsRequest(
  input: ParseNeedsInput,
  deps: {
    admin: UserClient;
    userId: string | null;
    generate?: typeof defaultGenerate;
  },
): Promise<ParseNeedsResponse> {
  const result: ParseNeedsResult = await parseNeeds({
    text: input.text,
    current: input.profile,
    generate: deps.generate,
  });

  await logUnmetNeeds(deps.admin, deps.userId, result.unsupported);

  if (!result.ok) {
    return {
      ok: false,
      unsupported: result.unsupported,
      message:
        result.reason === "invalid"
          ? "I could not make that change safely, so your settings are unchanged. Try describing it another way."
          : "Tell Prism what would help.",
    };
  }

  const changes = describeChanges(result.changes);
  const explanation =
    result.explanation || (changes.length > 0 ? "I updated your settings." : NOTHING_CHANGED);
  return {
    ok: true,
    profile: result.profile,
    changes,
    explanation:
      changes.length === 0 && result.unsupported.length > 0 ? `${explanation}` : explanation,
    unsupported: result.unsupported,
  };
}
