import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { logMailer, type Mailer } from "./mailer";

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

export const InviteRequest = z.object({
  email: z.email("Enter a valid email address.").max(320),
  role: z.enum(["teacher", "principal"]).default("teacher"),
});
export type InviteInput = z.infer<typeof InviteRequest>;

export interface CreatedInvite {
  invitationId: string;
  email: string;
  role: string;
  expiresAt: string;
  /** The link to give the invitee. Shown once; only a hash of its token is stored. */
  link: string;
  /** Whether an email was sent. False until an email provider is set up. */
  emailed: boolean;
}

/** Invites someone to the organization. Only its principal may; the database checks that. */
export async function inviteToOrg(
  user: UserClient,
  orgId: string,
  input: InviteInput,
  origin: string,
  mailer: Mailer = logMailer,
): Promise<CreatedInvite> {
  const { data, error } = await user.rpc("create_invitation", {
    p_org: orgId,
    p_email: input.email,
    p_role: input.role,
  });
  const row = data?.[0];
  if (error || !row) {
    if (error?.code === "42501") {
      throw new ServiceError(403, "forbidden", "Only the principal can invite people.");
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not create an invitation", { error: error?.message });
    throw new ServiceError(
      500,
      "invite_failed",
      "We could not create the invitation. Please try again.",
    );
  }

  const link = `${origin}/invite/${row.token}`;
  const org = await user.from("organizations").select("name").eq("id", orgId).maybeSingle();
  const mail = await mailer
    .sendInvitation({
      to: input.email,
      orgName: org.data?.name ?? "your school",
      role: input.role,
      link,
    })
    .catch(() => ({ sent: false }));

  return {
    invitationId: row.invitation_id,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    expiresAt: row.expires_at,
    link,
    emailed: mail.sent,
  };
}

export const AcceptInviteRequest = z.object({ token: z.string().min(16).max(200) });

/** Accepts an invitation as the signed-in user, who gets the invited role. */
export async function acceptInvitation(
  user: UserClient,
  token: string,
): Promise<{ orgId: string; role: string }> {
  const { data, error } = await user.rpc("accept_invitation", { p_token: token });
  const row = data?.[0];
  if (error || !row) {
    if (error?.code === "P0002") {
      throw new ServiceError(
        410,
        "invitation_invalid",
        "This invitation has expired or was already used. Ask for a new one.",
      );
    }
    if (error?.code === "42501") {
      throw new ServiceError(
        403,
        "wrong_account",
        "This invitation was sent to a different email address. Sign in with that address.",
      );
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not accept an invitation", { error: error?.message });
    throw new ServiceError(
      500,
      "accept_failed",
      "We could not accept the invitation. Please try again.",
    );
  }
  return { orgId: row.joined_org, role: row.joined_role };
}
