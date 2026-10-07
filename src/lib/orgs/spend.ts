import { z } from "zod";
import { ServiceError, type UserClient } from "@/lib/api/http";
import { logger } from "@/lib/log";

/**
 * An organization's monthly AI spend against the cap its principal set (PRD 6.2, P6-15). At
 * 80% the principal is warned. At 100% new uploads are paused with a clear message; work
 * already running is never cut off, and the pause lifts when the month turns or the cap is
 * raised. Only ingestion cost is counted so far, because it is the only cost recorded against
 * an organization.
 */

export const SPEND_ALERT_RATIO = 0.8;

export interface OrgSpend {
  /** The monthly cap in US dollars, or null when none is set. */
  capUsd: number | null;
  /** What has been spent this calendar month (UTC), in US dollars. */
  spentUsd: number;
}

export type SpendLevel = "none" | "ok" | "warning" | "blocked";

/** The share of the cap used, or null with no cap. A cap of 0 counts as fully used. */
export function spendRatio(spend: OrgSpend): number | null {
  if (spend.capUsd === null) return null;
  if (spend.capUsd === 0) return 1;
  return spend.spentUsd / spend.capUsd;
}

export function spendLevel(spend: OrgSpend): SpendLevel {
  const ratio = spendRatio(spend);
  if (ratio === null) return "none";
  if (ratio >= 1) return "blocked";
  return ratio >= SPEND_ALERT_RATIO ? "warning" : "ok";
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function loadOrgSpend(db: UserClient, orgId: string): Promise<OrgSpend> {
  const { data, error } = await db.rpc("org_spend", { p_org: orgId });
  if (error) {
    if (error.code === "42501") throw new ServiceError(404, "not_found", "School not found.");
    logger.error("could not read the school's spend", { error: error.message });
    throw new ServiceError(500, "read_failed", "We could not load the spend. Please try again.");
  }
  const row = data?.[0];
  return {
    capUsd: row?.cap_usd === null || row?.cap_usd === undefined ? null : Number(row.cap_usd),
    spentUsd: Number(row?.spent_usd ?? 0),
  };
}

/**
 * Stops a new upload for a school that has used its whole budget. Runs as the server, which
 * can read the spend, so a teacher is told only that the school has reached its limit and never
 * sees an amount. A failure to read the spend does not block the teacher: the cap is a soft
 * control, and an outage must not stop lessons being made.
 */
export async function assertIngestionAllowed(admin: UserClient, orgId: string): Promise<void> {
  let spend: OrgSpend;
  try {
    spend = await loadOrgSpend(admin, orgId);
  } catch (error) {
    logger.warn("could not check the spend cap; allowing the upload", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (spendLevel(spend) === "blocked") {
    throw new ServiceError(
      403,
      "spend_cap_reached",
      "Your school has reached its monthly limit for AI processing, so new uploads are paused. Ask your principal to raise the limit, or try again next month. Lessons you already have are not affected.",
    );
  }
}

export const SetSpendCapRequest = z.object({
  /** Whole or fractional US dollars. Null removes the cap. */
  capUsd: z
    .number("Enter an amount in dollars.")
    .min(0, "The limit cannot be below zero.")
    .max(1_000_000, "That limit is too high.")
    .nullable(),
});

export async function setSpendCap(
  user: UserClient,
  orgId: string,
  capUsd: number | null,
): Promise<OrgSpend> {
  const rounded = capUsd === null ? null : Math.round(capUsd * 100) / 100;
  const { data, error } = await user
    .from("organizations")
    .update({ monthly_spend_cap_usd: rounded })
    .eq("id", orgId)
    .select("id");
  if (error) {
    logger.error("could not set the spend cap", { error: error.message });
    throw new ServiceError(500, "update_failed", "We could not save the limit. Please try again.");
  }
  // Row-level security lets only the principal update, so no rows means not theirs.
  if (!data || data.length === 0) throw new ServiceError(404, "not_found", "School not found.");
  return loadOrgSpend(user, orgId);
}
