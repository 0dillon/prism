import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import type { Json } from "@/lib/supabase/database.types";
import { RenderProfile } from "@/lib/schemas/render-profile";

/**
 * Saving a learner's Render Profile (PRD 5.3, 7.5). Profiles are private to the learner:
 * the row is keyed by their user id and row-level security lets only them read or write it.
 */

export const SaveProfileInput = z.object({ profile: RenderProfile });

/** Saves the profile. Only the profile column is written, so the sharing opt-in is never reset. */
export async function saveProfile(
  user: UserClient,
  userId: string,
  profile: RenderProfile,
): Promise<void> {
  const { error } = await user
    .from("render_profiles")
    .upsert({ user_id: userId, profile: profile as Json }, { onConflict: "user_id" });
  if (error) {
    logger.error("could not save profile", { error: error.message });
    throw new ServiceError(
      500,
      "save_failed",
      "We could not save your settings. Please try again.",
    );
  }
}

/** The learner's saved profile, or null if they have never saved one or it no longer validates. */
export async function loadProfile(user: UserClient, userId: string): Promise<RenderProfile | null> {
  const { data, error } = await user
    .from("render_profiles")
    .select("profile")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new ServiceError(500, "read_failed", "We could not load your settings.");
  const parsed = RenderProfile.safeParse(data?.profile);
  return parsed.success ? parsed.data : null;
}
