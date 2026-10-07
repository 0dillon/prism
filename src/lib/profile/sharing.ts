import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * Whether a learner shares their settings with their teachers (PRD 5.8, 6.4, P6-09). It is off
 * until they turn it on. Changing it goes through one database function that also writes the
 * audit log, so there is no way to change it without a record.
 */

export const SharingRequest = z.object({ share: z.boolean() });

export async function setProfileSharing(
  user: UserClient,
  share: boolean,
): Promise<{ share: boolean }> {
  const { data, error } = await user.rpc("set_profile_sharing", { p_share: share });
  if (error || data === null) {
    if (error?.code === "P0002") {
      throw new ServiceError(
        409,
        "no_profile",
        "Save your settings first, then you can choose whether to share them.",
      );
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not change profile sharing", { error: error?.message });
    throw new ServiceError(
      500,
      "sharing_failed",
      "We could not save your choice. Please try again.",
    );
  }
  return { share: data };
}

/** The learner's current choice. No saved settings means nothing is shared. */
export async function loadSharing(user: UserClient, userId: string): Promise<boolean> {
  const { data } = await user
    .from("render_profiles")
    .select("share_with_teachers")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.share_with_teachers ?? false;
}
