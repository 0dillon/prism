/**
 * How an organization's monthly AI spend compares with its limit. Pure, so the budget card in the
 * browser can import it without pulling server code into the bundle. Reading the spend and
 * enforcing the limit are in spend.ts.
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
