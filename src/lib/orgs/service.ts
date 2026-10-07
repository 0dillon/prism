import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * Organizations (PRD 5.8, P6-01). Creating one runs as a single database function, which makes
 * the caller its principal and records it in the audit log in the same step.
 */

export const CreateOrgRequest = z.object({
  name: z.string().trim().min(1, "Enter your school's name.").max(200, "That name is too long."),
});

/** A web-safe version of a name: lowercase letters and digits separated by single hyphens. */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "school";
}

const UNIQUE_VIOLATION = "23505";
const MAX_ATTEMPTS = 5;

export async function createOrganization(
  user: UserClient,
  name: string,
): Promise<{ id: string; slug: string }> {
  const base = slugify(name);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // The first try is the plain name; if that is taken, a short suffix makes it different.
    const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const { data, error } = await user.rpc("create_organization", { p_name: name, p_slug: slug });
    if (!error && data) return { id: data, slug };
    if (error?.code === UNIQUE_VIOLATION) continue;
    if (error?.code === "28000") {
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    }
    logger.error("could not create an organization", { error: error?.message });
    throw new ServiceError(
      500,
      "create_failed",
      "We could not create the school. Please try again.",
    );
  }
  throw new ServiceError(
    409,
    "name_taken",
    "That name is already in use. Try a slightly different one.",
  );
}
