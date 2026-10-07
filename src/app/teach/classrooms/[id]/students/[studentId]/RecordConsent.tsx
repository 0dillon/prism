"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/**
 * Shown to a teacher or principal for a student under 13 whose account is paused. It lets the
 * school record that it holds the guardian's agreement on file. The choice is recorded in the
 * audit log with the name of the person who made it.
 */
export function RecordConsent({ studentId, name }: { studentId: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    setBusy(true);
    setError(null);
    const result = await sendJson(`/api/students/${studentId}/consent`, {});
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    announce(`Consent recorded. ${name} can now use Prism.`);
    router.refresh();
  };

  return (
    <section aria-labelledby="consent-heading" className="flex flex-col gap-3">
      <h2 id="consent-heading" className="text-xl font-semibold">
        Waiting for a parent or guardian
      </h2>
      <p>
        {name} is under 13, so their account is paused until a parent or guardian agrees. If your
        school already holds that agreement, you can record it here.
      </p>
      <div>
        <ConfirmDialog
          trigger={
            <Button variant="secondary" disabled={busy}>
              Record that the school holds consent
            </Button>
          }
          title={`Record consent for ${name}?`}
          description="Only do this if a parent or guardian has agreed to this student using Prism and the school keeps that on file. It is recorded with your name."
          confirmLabel="Record consent"
          onConfirm={record}
        />
      </div>
      {error ? (
        <p role="alert" className="text-danger font-medium">
          {error}
        </p>
      ) : null}
    </section>
  );
}
