"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/** A student types the code their teacher gave them to join a class. */
export function JoinClassForm() {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!code) {
      const message = "Enter the class code.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await sendJson("/api/classrooms/join", { code });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    form.reset();
    announce("You have joined the class.");
    router.refresh();
  };

  return (
    <section aria-labelledby="join-heading" className="flex flex-col gap-3">
      <h2 id="join-heading" className="text-xl font-semibold">
        Join a class
      </h2>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Class code"
          name="code"
          hint="Your teacher gives you a code of six letters and numbers."
          autoComplete="off"
          autoCapitalize="characters"
          maxLength={20}
          disabled={busy}
          error={error}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? "Joining…" : "Join class"}
          </Button>
        </div>
      </form>
    </section>
  );
}
