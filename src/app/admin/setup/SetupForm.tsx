"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/** Asks for the school's name and creates it; the person who does so becomes its principal. */
export function SetupForm() {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLDivElement>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) {
      const message = "Enter your school's name.";
      setError(message);
      announce(message, "assertive");
      inputRef.current?.querySelector("input")?.focus();
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await sendJson("/api/orgs", { name });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      announce(result.message, "assertive");
      inputRef.current?.querySelector("input")?.focus();
      return;
    }
    announce("Your school is set up.");
    router.push("/admin");
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div ref={inputRef}>
        <TextField
          label="School name"
          name="name"
          type="text"
          autoComplete="organization"
          maxLength={200}
          disabled={busy}
          error={error}
        />
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? "Setting up…" : "Set up my school"}
      </Button>
    </form>
  );
}
