"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/** Download your data, or ask for it all to be deleted. */
export function AccountActions({ deletionRequestedOn }: { deletionRequestedOn: string | null }) {
  const [requestedOn, setRequestedOn] = useState(deletionRequestedOn);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestDeletion = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ requestedAt: string | null }>("/api/account/deletion", {});
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setRequestedOn(result.data.requestedAt ?? "requested");
    announce("We have recorded your request to delete your account.");
  };

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="export-heading" className="flex flex-col gap-3">
        <h2 id="export-heading" className="text-xl font-semibold">
          Download your data
        </h2>
        <p className="text-muted">
          A file with your name, settings, progress and answers, and the classes you are in.
        </p>
        <p>
          <a href="/api/account/export" download className="font-semibold underline">
            Download my data
          </a>
        </p>
      </section>

      <section aria-labelledby="delete-heading" className="flex flex-col gap-3">
        <h2 id="delete-heading" className="text-xl font-semibold">
          Delete my account
        </h2>
        {requestedOn ? (
          <p role="status" className="border-line rounded-lg border p-3">
            You asked for your account and records to be deleted. We will do this within 30 days.
            You can still use Prism until then.
          </p>
        ) : (
          <>
            <p className="text-muted">
              This removes your account, your settings, your progress and your answers. It cannot be
              undone. Your teacher will no longer see you in their class.
            </p>
            <div>
              <ConfirmDialog
                trigger={
                  <Button variant="secondary" disabled={busy}>
                    Ask for my account to be deleted
                  </Button>
                }
                title="Delete your account?"
                description="We will delete your account and everything we hold about you within 30 days. This cannot be undone."
                confirmLabel="Ask for deletion"
                onConfirm={requestDeletion}
              />
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="text-danger font-medium">
            {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}
