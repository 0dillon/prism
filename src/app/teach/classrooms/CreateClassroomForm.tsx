"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { SelectField } from "@/components/SelectField";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

export interface OrgChoice {
  id: string;
  name: string;
}

/** Makes a class. With more than one school the teacher picks which; with one it is implied. */
export function CreateClassroomForm({ orgs }: { orgs: OrgChoice[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    if (!name) {
      const message = "Enter a name for the class.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await sendJson<{ id: string }>("/api/classrooms", {
      orgId: String(data.get("orgId") ?? orgs[0]?.id),
      name,
      grade: String(data.get("grade") ?? ""),
      subject: String(data.get("subject") ?? ""),
    });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    announce("Class created.");
    router.push(`/teach/classrooms/${result.data.id}`);
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <TextField label="Class name" name="name" maxLength={200} disabled={busy} error={error} />
      <TextField label="Grade (optional)" name="grade" maxLength={40} disabled={busy} />
      <TextField label="Subject (optional)" name="subject" maxLength={80} disabled={busy} />
      {orgs.length > 1 ? (
        <SelectField
          label="School"
          name="orgId"
          disabled={busy}
          options={orgs.map((o) => ({ value: o.id, label: o.name }))}
        />
      ) : null}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create class"}
        </Button>
      </div>
    </form>
  );
}
