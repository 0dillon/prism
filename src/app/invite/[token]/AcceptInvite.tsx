"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/** Where each role goes after joining. */
const DESTINATION: Record<string, string> = { teacher: "/teach/classrooms", principal: "/admin" };

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await sendJson<{ orgId: string; role: string }>("/api/invites/accept", {
      token,
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    announce("You have joined the school.");
    router.push(DESTINATION[result.data.role] ?? "/learn");
  };

  return (
    <div className="flex flex-col gap-4">
      <Button onClick={accept} disabled={busy}>
        {busy ? "Joining…" : "Accept invitation"}
      </Button>
      {error ? (
        <p role="alert" className="text-danger flex items-start gap-1 font-medium">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
