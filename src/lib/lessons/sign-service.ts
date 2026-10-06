import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { BUCKETS, createSignedDownloadUrl } from "@/lib/supabase/storage";

/**
 * Reviewing proposed sign links (PRD CE-9, task P2-16). The lesson's owner verifies or
 * removes each link. Only verified links reach learners; that rule lives in row-level
 * security, so nothing here has to enforce it again.
 */

export interface SignReviewItem {
  conceptId: string;
  verified: boolean;
  gloss: string;
  license: string;
  signerCredit: string | null;
  /** A short-lived URL for the clip, or null if one could not be made. */
  clipUrl: string | null;
}

export const SignAction = z.object({
  conceptId: z.string().min(1, "Missing the concept."),
  action: z.enum(["verify", "unverify", "remove"]),
});
export type SignAction = z.infer<typeof SignAction>;

type UrlSigner = (path: string) => Promise<string | null>;

export async function loadSignReview(
  user: UserClient,
  userId: string,
  lessonId: string,
  options: { signUrl?: UrlSigner } = {},
): Promise<SignReviewItem[]> {
  const { data: lesson } = await user
    .from("lessons")
    .select("id, owner_id")
    .eq("id", lessonId)
    .maybeSingle();
  if (!lesson || lesson.owner_id !== userId)
    throw new ServiceError(404, "not_found", "Lesson not found.");

  const { data, error } = await user
    .from("concept_sign_links")
    .select("concept_id, verified, sign_clips(gloss, storage_path, license, signer_credit)")
    .eq("lesson_id", lessonId);
  if (error) {
    logger.error("could not load sign links", { lessonId, error: error.message });
    throw new ServiceError(
      500,
      "read_failed",
      "We could not load the sign clips. Please try again.",
    );
  }

  const sign: UrlSigner =
    options.signUrl ??
    (async (path) => {
      try {
        return await createSignedDownloadUrl(user, BUCKETS.signClips, path);
      } catch {
        return null;
      }
    });

  const items: SignReviewItem[] = [];
  for (const row of data ?? []) {
    const clip = Array.isArray(row.sign_clips) ? row.sign_clips[0] : row.sign_clips;
    if (!clip) continue;
    items.push({
      conceptId: row.concept_id,
      verified: row.verified,
      gloss: clip.gloss,
      license: clip.license,
      signerCredit: clip.signer_credit,
      clipUrl: await sign(clip.storage_path),
    });
  }
  return items;
}

/** Verifies, un-verifies or removes one link for a lesson the user owns. */
export async function updateSignLink(
  user: UserClient,
  userId: string,
  lessonId: string,
  input: SignAction,
): Promise<{ conceptId: string; verified: boolean | null }> {
  const { data: lesson } = await user
    .from("lessons")
    .select("id, owner_id")
    .eq("id", lessonId)
    .maybeSingle();
  if (!lesson || lesson.owner_id !== userId)
    throw new ServiceError(404, "not_found", "Lesson not found.");

  if (input.action === "remove") {
    const { data, error } = await user
      .from("concept_sign_links")
      .delete()
      .eq("lesson_id", lessonId)
      .eq("concept_id", input.conceptId)
      .select("id");
    if (error)
      throw new ServiceError(
        500,
        "update_failed",
        "We could not remove that sign. Please try again.",
      );
    if (!data || data.length === 0)
      throw new ServiceError(404, "not_found", "That sign was not found.");
    return { conceptId: input.conceptId, verified: null };
  }

  const verified = input.action === "verify";
  const { data, error } = await user
    .from("concept_sign_links")
    .update({ verified, verified_by: verified ? userId : null })
    .eq("lesson_id", lessonId)
    .eq("concept_id", input.conceptId)
    .select("id");
  if (error) {
    logger.error("could not update sign link", { lessonId, error: error.message });
    throw new ServiceError(
      500,
      "update_failed",
      "We could not update that sign. Please try again.",
    );
  }
  if (!data || data.length === 0)
    throw new ServiceError(404, "not_found", "That sign was not found.");
  return { conceptId: input.conceptId, verified };
}
