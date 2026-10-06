"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { NeedsBox } from "@/components/NeedsBox";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Button } from "@/components/Button";
import { announce } from "@/lib/a11y/live-region";
import { browserStorageOrNull, createDemoKits } from "@/lib/demo/kits";
import { DEMO_LEARNERS, type DemoLearnerId } from "@/lib/demo/learners";
import { SAMPLE_GRAPH_VERSION, SAMPLE_LESSON, SAMPLE_VARIANTS } from "@/lib/demo/sample-lesson";
import { PRESET_DESCRIPTIONS } from "@/lib/profile/presets";
import { PrismRenderer } from "@/renderers/PrismRenderer";
import { createFixedVariantSource, VariantSourceContext } from "@/renderers/shared/variant-source";

const variantSource = createFixedVariantSource(SAMPLE_VARIANTS, SAMPLE_GRAPH_VERSION);

const noSubscription = () => () => {};

/**
 * The demo page's player (PRD P9-03): one screen with a learner switcher and the lesson, so
 * the same lesson can be shown as different learners without signing in or out. Each
 * learner keeps their own settings and place. It works from a lesson written into the
 * page, so it needs no account, no model and no network.
 */
export function DemoPlayer() {
  // Settings and progress live in the browser, so there is nothing to draw until it is mounted.
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!mounted)
    return (
      <p role="status" className="p-6">
        Loading the demo…
      </p>
    );
  return <DemoStage />;
}

function DemoStage() {
  const kits = useMemo(() => createDemoKits(browserStorageOrNull()), []);
  const [learnerId, setLearnerId] = useState<DemoLearnerId>(DEMO_LEARNERS[0].id);
  // Bumped on reset, so the lesson on screen is rebuilt from the fresh stores.
  const [resets, setResets] = useState(0);
  const kit = useMemo(() => {
    // `resets` is read so a reset produces a new kit even for the same learner.
    void resets;
    return kits.kitFor(learnerId);
  }, [kits, learnerId, resets]);

  const statusRef = useRef<HTMLParagraphElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // After the learner changes, say who is showing and put focus there, so a keyboard or
    // screen reader user is not left on a button that now controls something else.
    if (first.current) {
      first.current = false;
      return;
    }
    statusRef.current?.focus();
  }, [learnerId, resets]);

  const preset = PRESET_DESCRIPTIONS[kit.learner.preset];

  return (
    <VariantSourceContext.Provider value={variantSource}>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4">
        <section
          aria-label="Demo controls"
          className="border-line flex flex-col gap-4 rounded-lg border p-4"
        >
          <p>
            This is a sample lesson. Pick a learner to see the same lesson the way they like to
            learn it. Each keeps their own settings and place, saved in this browser only.
          </p>

          <div role="group" aria-labelledby="demo-learner-label" className="flex flex-col gap-2">
            <p id="demo-learner-label" className="font-semibold">
              Learner
            </p>
            <ul className="flex flex-wrap gap-2">
              {DEMO_LEARNERS.map((learner) => {
                const current = learner.id === learnerId;
                return (
                  <li key={learner.id}>
                    <button
                      type="button"
                      aria-pressed={current}
                      onClick={() => {
                        setLearnerId(learner.id);
                        announce(`Showing the lesson as ${learner.name}.`);
                      }}
                      className={`min-h-11 min-w-11 cursor-pointer rounded-md border px-4 py-2 font-semibold ${
                        current
                          ? "bg-accent text-accent-foreground border-transparent"
                          : "bg-background border-line"
                      }`}
                    >
                      {learner.name + (current ? " (current)" : "")}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <p ref={statusRef} tabIndex={-1} className="text-muted outline-none">
            Showing {kit.learner.name}, who likes: {preset.label.toLowerCase()}.
          </p>

          <div className="flex flex-wrap gap-3">
            <SettingsPanel profileStore={kit.profileStore} />
            <Button
              variant="secondary"
              onClick={() => {
                kits.reset(learnerId);
                setResets((n) => n + 1);
                announce(`${kit.learner.name} has started over.`);
              }}
            >
              Start {kit.learner.name} over
            </Button>
          </div>
        </section>

        <PrismRenderer
          key={`${learnerId}-${resets}`}
          graph={SAMPLE_LESSON}
          sessionStore={kit.sessionStore}
          profileStore={kit.profileStore}
        />

        <NeedsBox profileStore={kit.profileStore} />
      </div>
    </VariantSourceContext.Provider>
  );
}
