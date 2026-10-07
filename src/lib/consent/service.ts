import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";
import { logMailer, type Mailer } from "@/lib/orgs/mailer";

/**
 * Guardian consent and a learner's own data rights (PRD 6.4, P6-16). The database decides who
 * is inactive and how consent is granted; this module is the thin layer in front of it. A
 * consent link goes to the guardian and is never shown to the child, and nothing here returns
 * a token to a browser.
 */

export type ConsentStatus = "not_required" | "pending" | "granted";

export interface ConsentState {
  status: ConsentStatus;
  /** A guardian's address has been given and a link made. */
  requested: boolean;
}

/** An account made without a date of birth is not restricted. */
export async function loadConsent(user: UserClient, userId: string): Promise<ConsentState> {
  const { data } = await user
    .from("user_consents")
    .select("status, requested_at")
    .eq("user_id", userId)
    .maybeSingle();
  const status = data?.status;
  return {
    status: status === "pending" || status === "granted" ? status : "not_required",
    requested: Boolean(data?.requested_at),
  };
}

export const GuardianRequest = z.object({
  guardianEmail: z
    .string()
    .trim()
    .min(1, "Enter your parent or guardian's email address.")
    .pipe(z.email("Enter a valid email address.")),
});

export async function requestGuardianConsent(
  user: UserClient,
  input: { guardianEmail: string },
  childName: string,
  origin: string,
  mailer: Mailer = logMailer,
): Promise<{ requested: true; emailed: boolean }> {
  const { data: token, error } = await user.rpc("request_guardian_consent", {
    p_guardian_email: input.guardianEmail,
  });
  if (error || !token) {
    if (error?.code === "P0001") {
      throw new ServiceError(
        409,
        "not_needed",
        "Your account does not need a parent or guardian to agree.",
      );
    }
    if (error?.code === "28000")
      throw new ServiceError(401, "unauthorized", "Sign in to continue.");
    logger.error("could not request guardian consent", { error: error?.message });
    throw new ServiceError(
      500,
      "request_failed",
      "We could not send the request. Please try again.",
    );
  }
  const sent = await mailer
    .sendGuardianConsent({
      to: input.guardianEmail.trim().toLowerCase(),
      childName,
      link: `${origin}/consent/${token}`,
    })
    .catch(() => ({ sent: false }));
  return { requested: true, emailed: sent.sent };
}

export const GrantConsentRequest = z.object({ token: z.string().min(16).max(200) });

/** The guardian follows their link. Runs as the server, because the guardian has no account. */
export async function grantGuardianConsent(admin: UserClient, token: string): Promise<void> {
  const { error } = await admin.rpc("grant_guardian_consent", { p_token: token });
  if (error) {
    if (error.code === "P0002") {
      throw new ServiceError(
        410,
        "link_invalid",
        "This link has expired or was already used. Ask the student to send a new request.",
      );
    }
    logger.error("could not record guardian consent", { error: error.message });
    throw new ServiceError(
      500,
      "grant_failed",
      "We could not record your answer. Please try again.",
    );
  }
}

/** A teacher or principal records that the school holds the guardian's agreement on file. */
export async function recordSchoolConsent(user: UserClient, studentId: string): Promise<void> {
  const { error } = await user.rpc("record_school_consent", { p_student: studentId });
  if (error) {
    if (error.code === "42501") throw new ServiceError(404, "not_found", "Student not found.");
    if (error.code === "P0001") {
      throw new ServiceError(409, "not_needed", "This student does not need consent recorded.");
    }
    logger.error("could not record school consent", { error: error.message });
    throw new ServiceError(500, "record_failed", "We could not record consent. Please try again.");
  }
}

/** The ids of students in a class who are waiting for consent. Empty for anyone but its staff. */
export async function listPendingConsents(
  user: UserClient,
  classroomId: string,
): Promise<Set<string>> {
  const { data } = await user.rpc("pending_consents", { p_classroom: classroomId });
  return new Set((data ?? []).map((r) => r.student_id));
}
