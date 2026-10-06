"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { announce } from "@/lib/a11y/live-region";
import type { SignAction, SignReviewItem } from "@/lib/lessons/sign-service";

export interface SignConcept {
  id: string;
  title: string;
  keyTerm?: string;
}

export type SignCall = (lessonId: string, input: SignAction) => Promise<void>;

const defaultCall: SignCall = async (lessonId, input) => {
  const response = await fetch(`/api/lessons/${lessonId}/signs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(json?.error?.message ?? "We could not update that sign.");
  }
};

interface SignsPanelProps {
  lessonId: string;
  items: SignReviewItem[];
  concepts: SignConcept[];
  /** Override the network call. Used by tests. */
  call?: SignCall;
}

export function SignsPanel({
  lessonId,
  items: initial,
  concepts,
  call = defaultCall,
}: SignsPanelProps) {
  const [items, setItems] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  // A link for a concept that is no longer in the lesson has nothing to show.
  const visible = items.filter((item) => conceptById.has(item.conceptId));
  const unverified = visible.filter((item) => !item.verified).length;

  const act = async (item: SignReviewItem, action: SignAction["action"]) => {
    const title = conceptById.get(item.conceptId)?.title ?? "this concept";
    setBusy(item.conceptId);
    setError(null);
    try {
      await call(lessonId, { conceptId: item.conceptId, action });
      setItems((current) =>
        action === "remove"
          ? current.filter((i) => i.conceptId !== item.conceptId)
          : current.map((i) =>
              i.conceptId === item.conceptId ? { ...i, verified: action === "verify" } : i,
            ),
      );
      announce(
        action === "remove"
          ? `Removed the sign for ${title}.`
          : action === "verify"
            ? `Verified the sign for ${title}.`
            : `Marked the sign for ${title} as needing a check.`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "We could not update that sign.";
      setError(message);
      announce(`Not updated. ${message}`, "assertive");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <p>
          Prism proposed sign clips for key terms. Learners only see a clip after you verify it.
          Have a fluent signer confirm that the sign matches the term before you verify it.
        </p>
        <p className="text-muted">
          Signs are shown for key terms. This is not a full translation. A concept without a
          verified sign shows its key term fingerspelled instead.
        </p>
      </div>

      {error ? (
        <p role="alert" tabIndex={-1} className="text-danger flex items-start gap-2 font-medium">
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p>
          No sign clips were matched to this lesson&rsquo;s key terms. Every key term will be shown
          fingerspelled.
        </p>
      ) : (
        <>
          <p role="status">
            {visible.length} proposed {visible.length === 1 ? "sign" : "signs"}
            {unverified > 0 ? `, ${unverified} to verify` : ", all verified"}.
          </p>
          <ul className="flex flex-col gap-6">
            {visible.map((item) => {
              const concept = conceptById.get(item.conceptId)!;
              const headingId = `sign-${item.conceptId}`;
              return (
                <li key={item.conceptId}>
                  <article
                    aria-labelledby={headingId}
                    className="border-line flex flex-col gap-4 rounded-lg border p-5"
                  >
                    <h3 id={headingId} className="text-xl font-semibold">
                      {concept.title}
                    </h3>
                    <p>
                      Key term: <strong>{concept.keyTerm ?? "none"}</strong>. Proposed sign:{" "}
                      <strong>{item.gloss}</strong>.
                    </p>
                    {item.clipUrl ? (
                      <video
                        controls
                        preload="metadata"
                        playsInline
                        aria-label={`Sign for ${item.gloss}`}
                        src={item.clipUrl}
                        className="bg-surface max-h-72 w-full max-w-md rounded-md"
                      />
                    ) : (
                      <p className="text-muted">The clip could not be loaded right now.</p>
                    )}
                    <p className="font-medium">
                      {item.verified ? (
                        <>
                          <span aria-hidden="true">✓ </span>Verified. Learners can see this sign.
                        </>
                      ) : (
                        <>
                          <span aria-hidden="true">⚑ </span>Needs checking. Learners cannot see it
                          yet.
                        </>
                      )}
                    </p>
                    <p className="text-muted text-sm">
                      License: {item.license}
                      {item.signerCredit ? `. Signer: ${item.signerCredit}` : ""}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      {item.verified ? (
                        <Button
                          variant="secondary"
                          disabled={busy === item.conceptId}
                          aria-label={`Un-verify the sign for ${concept.title}`}
                          onClick={() => void act(item, "unverify")}
                        >
                          Un-verify
                        </Button>
                      ) : (
                        <Button
                          disabled={busy === item.conceptId}
                          aria-label={`Verify the sign for ${concept.title}`}
                          onClick={() => void act(item, "verify")}
                        >
                          Verify
                        </Button>
                      )}
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="secondary"
                            disabled={busy === item.conceptId}
                            aria-label={`Remove the sign for ${concept.title}`}
                          >
                            Remove
                          </Button>
                        }
                        title="Remove this sign?"
                        description={`Learners will see ${concept.keyTerm ?? "the key term"} fingerspelled instead of the ${item.gloss} sign.`}
                        confirmLabel="Remove sign"
                        onConfirm={() => void act(item, "remove")}
                      />
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
