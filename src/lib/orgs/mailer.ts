import { logger } from "@/lib/log";

/**
 * Sends the invitation email. No email provider is set up yet (PRD 9.2), so the default only
 * records that an invitation was made and reports that nothing was sent; the principal gets
 * the link on screen and shares it themselves. A real provider replaces `logMailer` without
 * changing the callers.
 */
export interface InvitationMail {
  to: string;
  orgName: string;
  role: string;
  link: string;
}

export interface GuardianConsentMail {
  to: string;
  /** The child's first name or display name, so the guardian knows who is asking. */
  childName: string;
  link: string;
}

export interface Mailer {
  sendInvitation(mail: InvitationMail): Promise<{ sent: boolean }>;
  sendGuardianConsent(mail: GuardianConsentMail): Promise<{ sent: boolean }>;
}

export const logMailer: Mailer = {
  async sendInvitation(mail) {
    // The link carries the secret token, so it is never logged.
    logger.info("invitation created, no email provider configured", {
      role: mail.role,
      org: mail.orgName,
    });
    return { sent: false };
  },
  async sendGuardianConsent() {
    // The link carries the secret token and the address is personal data: neither is logged.
    logger.info("guardian consent requested, no email provider configured");
    return { sent: false };
  },
};
