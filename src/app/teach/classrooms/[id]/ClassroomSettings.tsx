"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";
import type { ClassroomSummary } from "@/lib/classrooms/service";

/** Rename a class, change its grade and subject, and archive or restore it. */
export function ClassroomSettings({ classroom }: { classroom: ClassroomSummary }) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(undefined);
    const result = await sendJson(`/api/classrooms/${classroom.id}`, body, "PATCH");
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return false;
    }
    announce(done);
    router.refresh();
    return true;
  };

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
    await save(
      { name, grade: String(data.get("grade") ?? ""), subject: String(data.get("subject") ?? "") },
      "Class saved.",
    );
  };

  return (
    <section aria-labelledby="settings-heading" className="flex flex-col gap-4">
      <h2 id="settings-heading" className="text-xl font-semibold">
        Class settings
      </h2>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Class name"
          name="name"
          defaultValue={classroom.name}
          maxLength={200}
          disabled={busy}
          error={error}
        />
        <TextField
          label="Grade"
          name="grade"
          defaultValue={classroom.grade ?? ""}
          maxLength={40}
          disabled={busy}
        />
        <TextField
          label="Subject"
          name="subject"
          defaultValue={classroom.subject ?? ""}
          maxLength={80}
          disabled={busy}
        />
        <div>
          <Button type="submit" disabled={busy}>
            Save changes
          </Button>
        </div>
      </form>

      {classroom.archived ? (
        <div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => save({ archived: false }, "Class restored.")}
          >
            Restore this class
          </Button>
        </div>
      ) : (
        <div>
          <ConfirmDialog
            trigger={
              <Button variant="secondary" disabled={busy}>
                Archive this class
              </Button>
            }
            title="Archive this class?"
            description="It leaves your list and the school's summary. Students keep their progress, and you can restore it later."
            confirmLabel="Archive"
            onConfirm={async () => {
              if (await save({ archived: true }, "Class archived."))
                router.push("/teach/classrooms");
            }}
          />
        </div>
      )}
    </section>
  );
}
