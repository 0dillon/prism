"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/** The guardian's single choice. They need no account. */
export function GuardianConsent({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const agree = async () => {
    setState("busy");
    setError(null);
    const result = await sendJson("/api/consent/grant", { token });
    if (!result.ok) {
      setState("idle");
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setState("done");
    announce("Thank you. Your child can now use Prism.");
  };

  if (state === "done") {
    return (
      <p role="status" className="border-line rounded-lg border p-4 font-medium">
        Thank you. Your child can now use Prism. You can close this page.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Button onClick={agree} disabled={state === "busy"}>
        {state === "busy" ? "Saving…" : "I am this child's parent or guardian, and I agree"}
      </Button>
      <p className="text-muted text-sm">
        If you did not expect this, or do not agree, you can close this page. Nothing will change
        and your child&rsquo;s account stays paused.
      </p>
      {error ? (
        <p role="alert" className="text-danger font-medium">
          {error}
        </p>
      ) : null}
    </div>
  );
}
