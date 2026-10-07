"use client";

import { useState } from "react";
import { announce } from "@/lib/a11y/live-region";
import { sendJson } from "@/lib/api/client";

/**
 * The learner's choice about their teachers seeing their settings. Off by default. The text
 * says exactly what is and is not shared, and the choice is recorded each time it changes.
 */
export function ShareSettingsToggle({ initial }: { initial: boolean }) {
  const [shared, setShared] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (next: boolean) => {
    setBusy(true);
    setError(null);
    const result = await sendJson<{ share: boolean }>(
      "/api/profile/sharing",
      { share: next },
      "PUT",
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      announce(result.message, "assertive");
      return;
    }
    setShared(result.data.share);
    announce(
      result.data.share
        ? "Your teachers can now see your settings."
        : "Your teachers can no longer see your settings.",
    );
  };

  return (
    <section aria-labelledby="privacy-heading" className="flex flex-col gap-3">
      <h2 id="privacy-heading" className="text-xl font-semibold">
        Privacy
      </h2>
      <label className="flex min-h-11 items-start gap-3">
        <input
          type="checkbox"
          checked={shared}
          disabled={busy}
          onChange={(event) => change(event.target.checked)}
          aria-describedby="share-hint"
          className="mt-1 size-5"
        />
        <span>Share my settings with my teachers</span>
      </label>
      <p id="share-hint" className="text-muted text-sm">
        Off by default. When it is on, your teachers can see how you set up Prism, such as the
        layout and text size. They never see this when it is off. They always see your progress in
        lessons they give you. You can change this at any time, and each change is recorded.
      </p>
      {error ? (
        <p role="alert" className="text-danger font-medium">
          {error}
        </p>
      ) : null}
    </section>
  );
}
