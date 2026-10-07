"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

export interface AssignedItem {
  lessonId: string;
  title: string;
  dueLabel: string | null;
}

/** The lessons given to this class, each with a way to see its progress or take it away. */
export function AssignedLessons({
  classroomId,
  items,
}: {
  classroomId: string;
  items: AssignedItem[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (item: AssignedItem) => {
    setBusy(true);
    setError(null);
    const result = await sendJson(
      "/api/assignments",
      { lessonId: item.lessonId, classroomId },
      "DELETE",
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    announce(`${item.title} was taken away from this class.`);
    router.refresh();
  };

  return (
    <section aria-labelledby="assigned-heading" className="flex flex-col gap-3">
      <h2 id="assigned-heading" className="text-xl font-semibold">
        Assigned lessons
      </h2>
      {items.length === 0 ? (
        <p className="text-muted">
          Nothing is assigned yet. Open a published lesson&rsquo;s progress page to assign it.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.lessonId}
              className="border-line flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <span>
                <Link href={`/teach/lessons/${item.lessonId}/progress`} className="underline">
                  {item.title}
                </Link>
                {item.dueLabel ? <span className="text-muted"> · {item.dueLabel}</span> : null}
              </span>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => remove(item)}
                aria-label={`Take ${item.title} away from this class`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-danger font-medium">
          {error}
        </p>
      ) : null}
    </section>
  );
}
