import type { UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { BUCKETS, createSignedDownloadUrl } from "@/lib/supabase/storage";

/**
 * The sign clips a learner may see for a lesson (PRD 5.6.4). Row-level security already
 * limits the rows to verified links on lessons the learner can read; the filter here is a
 * second check, not the rule. A clip whose URL cannot be made is left out: the learner
 * then sees the key term fingerspelled instead, which is still true to the lesson.
 */

export interface LearnerSignClipRow {
  conceptId: string;
  gloss: string;
  url: string;
  license: string;
  signerCredit: string | null;
}

type UrlSigner = (path: string) => Promise<string | null>;

export async function loadLearnerSignClips(
  user: UserClient,
  lessonId: string,
  options: { signUrl?: UrlSigner } = {},
): Promise<LearnerSignClipRow[]> {
  const { data, error } = await user
    .from("concept_sign_links")
    .select("concept_id, verified, sign_clips(gloss, storage_path, license, signer_credit)")
    .eq("lesson_id", lessonId)
    .eq("verified", true);
  if (error) {
    logger.warn("could not load sign clips", { lessonId, error: error.message });
    return [];
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

  const rows: LearnerSignClipRow[] = [];
  for (const row of data ?? []) {
    if (!row.verified) continue;
    const clip = Array.isArray(row.sign_clips) ? row.sign_clips[0] : row.sign_clips;
    if (!clip) continue;
    const url = await sign(clip.storage_path);
    if (!url) continue;
    rows.push({
      conceptId: row.concept_id,
      gloss: clip.gloss,
      url,
      license: clip.license,
      signerCredit: clip.signer_credit,
    });
  }
  return rows;
}

export function toClipMap(rows: readonly LearnerSignClipRow[]) {
  return Object.fromEntries(
    rows.map((r) => [
      r.conceptId,
      { gloss: r.gloss, url: r.url, license: r.license, signerCredit: r.signerCredit },
    ]),
  );
}
