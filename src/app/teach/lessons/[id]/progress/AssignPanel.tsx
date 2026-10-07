"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

export interface AssignChoice {
  id: string;
  name: string;
  /** Already assigned to this class, with its due date if it has one. */
  assigned: boolean;
  dueLabel: string | null;
}

/** Choose classes and an optional due date, and give them this published lesson. */
export function AssignPanel({
  lessonId,
  classrooms,
}: {
  lessonId: string;
  classrooms: AssignChoice[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const classroomIds = data.getAll("classroom").map(String);
    if (classroomIds.length === 0) {
      const message = "Choose at least one class.";
      setError(message);
      announce(message, "assertive");
      return;
    }
    const dueDate = String(data.get("dueDate") ?? "");
    setError(undefined);
    setBusy(true);
    const result = await sendJson("/api/assignments", {
      lessonId,
      classroomIds,
      dueDate: dueDate || null,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    announce(
      classroomIds.length === 1
        ? "Lesson assigned to 1 class."
        : `Lesson assigned to ${classroomIds.length} classes.`,
    );
    router.refresh();
  };

  if (classrooms.length === 0) {
    return (
      <p className="text-muted">
        You have no classes yet. Create a class first, then come back to assign this lesson.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">Assign to</legend>
        {classrooms.map((room) => (
          <label key={room.id} className="flex min-h-11 items-center gap-3">
            <input
              type="checkbox"
              name="classroom"
              value={room.id}
              defaultChecked={room.assigned}
              disabled={busy}
              className="size-5"
            />
            <span>
              {room.name}
              {room.assigned ? (
                <span className="text-muted">
                  {" "}
                  (already assigned{room.dueLabel ? `, ${room.dueLabel.toLowerCase()}` : ""})
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
      <TextField
        label="Due date (optional)"
        name="dueDate"
        type="date"
        hint="It applies to every class you tick. Students can still open the lesson after this date."
        disabled={busy}
        error={error}
      />
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Assigning…" : "Assign lesson"}
        </Button>
      </div>
    </form>
  );
}
