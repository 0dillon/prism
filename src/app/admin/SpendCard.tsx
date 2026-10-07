"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";
import {
  SPEND_ALERT_RATIO,
  formatUsd,
  spendLevel,
  spendRatio,
  type OrgSpend,
} from "@/lib/orgs/spend-level";
import { ProgressBar } from "@/renderers/shared/ProgressBar";

/**
 * This month's AI spend against the school's limit. At 80% it warns, and at 100% it says new
 * uploads are paused. A warning is text and an icon, never colour alone.
 */
export function SpendCard({ orgId, spend }: { orgId: string; spend: OrgSpend }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const level = spendLevel(spend);
  const ratio = spendRatio(spend);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const raw = String(new FormData(event.currentTarget).get("cap") ?? "").trim();
    const capUsd = raw === "" ? null : Number(raw);
    if (capUsd !== null && (!Number.isFinite(capUsd) || capUsd < 0)) {
      const message = "Enter an amount in dollars, such as 50.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await sendJson(`/api/orgs/${orgId}/spend-cap`, { capUsd }, "PUT");
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    announce(capUsd === null ? "The limit was removed." : `The limit is now ${formatUsd(capUsd)}.`);
    router.refresh();
  };

  return (
    <section aria-labelledby="spend-heading" className="flex flex-col gap-4">
      <h2 id="spend-heading" className="text-xl font-semibold">
        AI processing budget
      </h2>

      {level === "warning" ? (
        <p
          role="status"
          className="border-line flex items-start gap-2 rounded-lg border p-3 font-medium"
        >
          <span aria-hidden="true">⚠</span>
          <span>
            Your school has used {Math.round((ratio ?? 0) * 100)}% of this month&rsquo;s limit. At
            100%, new uploads are paused until next month or until you raise the limit.
          </span>
        </p>
      ) : null}
      {level === "blocked" ? (
        <p
          role="alert"
          className="border-line flex items-start gap-2 rounded-lg border p-3 font-medium"
        >
          <span aria-hidden="true">⛔</span>
          <span>
            Your school has reached this month&rsquo;s limit, so teachers cannot start new uploads.
            Lessons already made are not affected. Raise the limit below to continue.
          </span>
        </p>
      ) : null}

      <p>
        Spent this month on processing uploaded material:{" "}
        <strong>{formatUsd(spend.spentUsd)}</strong>
        {spend.capUsd === null ? (
          ". There is no limit set."
        ) : (
          <>
            {" "}
            of a <strong>{formatUsd(spend.capUsd)}</strong> limit.
          </>
        )}
      </p>
      {ratio !== null ? (
        <ProgressBar
          value={ratio}
          label="Share of the monthly limit used"
          text={`${Math.round(Math.min(ratio, 1) * 100)}% used`}
        />
      ) : null}
      <p className="text-muted text-sm">
        You are warned at {Math.round(SPEND_ALERT_RATIO * 100)}%. Only the cost of processing
        uploaded material is counted so far.
      </p>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <TextField
          label="Monthly limit in dollars"
          name="cap"
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          defaultValue={spend.capUsd ?? ""}
          hint="Leave empty for no limit."
          disabled={busy}
          error={error}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save limit"}
          </Button>
        </div>
      </form>
    </section>
  );
}
