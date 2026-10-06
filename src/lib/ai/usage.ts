/**
 * Token and cost accounting for LLM calls (PRD 6.2). A tracker collects one record per
 * call, including retries, so ingestion_jobs can store honest totals.
 *
 * Prices are not hard-coded. Provider pricing changes, so each model's price is set
 * explicitly with `setModelPrice`; a model with no price reports cost 0 and
 * `costKnown: false` rather than a guess. Task P8-06 wires real prices for the report.
 */

export type Tier = "heavy" | "fast";

export interface ModelPrice {
  /** USD per one million input tokens. */
  inputPerMTok: number;
  /** USD per one million output tokens. */
  outputPerMTok: number;
}

const prices = new Map<string, ModelPrice>();

export function setModelPrice(model: string, price: ModelPrice): void {
  prices.set(model, price);
}

export function clearModelPrices(): void {
  prices.clear();
}

export function estimateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): { costUsd: number; costKnown: boolean } {
  const price = prices.get(model);
  if (!price) return { costUsd: 0, costKnown: false };
  const costUsd =
    (tokensIn / 1_000_000) * price.inputPerMTok + (tokensOut / 1_000_000) * price.outputPerMTok;
  return { costUsd, costKnown: true };
}

export interface UsageRecord {
  tier: Tier;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  costKnown: boolean;
  latencyMs: number;
  /** True when the call failed validation and was retried or abandoned. */
  validationFailed: boolean;
}

export type UsageCallback = (record: UsageRecord) => void;

export interface UsageTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** False if any call used a model with no registered price. */
  costComplete: boolean;
}

export class UsageTracker {
  private readonly records: UsageRecord[] = [];

  /** Pass as `onUsage`. Bound so it can be handed around directly. */
  readonly record: UsageCallback = (record) => {
    this.records.push(record);
  };

  get all(): readonly UsageRecord[] {
    return this.records;
  }

  totals(): UsageTotals {
    return summarize(this.records);
  }

  totalsByTier(): Record<Tier, UsageTotals> {
    return {
      heavy: summarize(this.records.filter((r) => r.tier === "heavy")),
      fast: summarize(this.records.filter((r) => r.tier === "fast")),
    };
  }
}

function summarize(records: readonly UsageRecord[]): UsageTotals {
  return {
    calls: records.length,
    tokensIn: records.reduce((sum, r) => sum + r.tokensIn, 0),
    tokensOut: records.reduce((sum, r) => sum + r.tokensOut, 0),
    costUsd: records.reduce((sum, r) => sum + r.costUsd, 0),
    costComplete: records.every((r) => r.costKnown),
  };
}
