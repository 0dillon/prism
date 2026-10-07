"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/**
 * Shown instead of the lessons while a learner under 13 waits for a parent or guardian to
 * agree. It explains plainly what is happening and what to do, and never shows the consent
 * link: that goes only to the guardian.
 */
export function ConsentPending({ requested: alreadyRequested }: { requested: boolean }) {
  const router = useRouter();
  const [requested, setRequested] = useState(alreadyRequested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const guardianEmail = String(
      new FormData(event.currentTarget).get("guardianEmail") ?? "",
    ).trim();
    if (!guardianEmail) {
      const message = "Enter your parent or guardian's email address.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await sendJson("/api/consent/request", { guardianEmail });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setRequested(true);
    announce("We have asked your parent or guardian.");
    router.refresh();
  };

  return (
    <section aria-labelledby="consent-heading" className="flex flex-col gap-4">
      <h2 id="consent-heading" className="text-2xl font-semibold">
        A parent or guardian needs to say yes first
      </h2>
      <p>
        Because you are under 13, we need a parent or guardian to agree before you can use Prism.
        Until then your lessons are paused. Nothing you have done has been lost.
      </p>
      {requested ? (
        <p role="status" className="border-line rounded-lg border p-3">
          We have asked your parent or guardian. When they agree, this page will show your lessons.
          Your teacher can also tell us the school already has their agreement.
        </p>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
        <TextField
          label={
            requested ? "Ask again, or use a different address" : "Your parent or guardian's email"
          }
          name="guardianEmail"
          type="email"
          autoComplete="off"
          hint="We will send them a link that explains what Prism is and asks if it is okay."
          disabled={busy}
          error={error}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Sending…" : requested ? "Ask again" : "Ask my parent or guardian"}
          </Button>
        </div>
      </form>
    </section>
  );
}
