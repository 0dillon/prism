"use client";

import { useEffect, useState } from "react";
import { SettingsPanel } from "@/components/SettingsPanel";
import { getProfileStore } from "@/lib/profile/store";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { getEventQueue, track } from "@/lib/session/events";
import { createSessionStore } from "@/lib/session/store";
import { trackProfileChanges } from "@/lib/session/telemetry";
import { PrismRenderer } from "@/renderers/PrismRenderer";
import { SignClipsContext, type SignClipMap } from "@/renderers/visual/signs";

interface LessonPlayerProps {
  lessonId: string;
  graphVersion: number;
  graph: KnowledgeGraph;
  /** Verified sign clips for this lesson, by concept. Empty if there are none. */
  signClips?: SignClipMap;
}

/**
 * Mounts one learner session for a lesson and hands it to PrismRenderer. The session
 * reads the quiz cadence from the profile each time, so changing it takes effect at once.
 * The settings button sits above the lesson, so every setting is reachable in every layout.
 */
export function LessonPlayer({ lessonId, graphVersion, graph, signClips = {} }: LessonPlayerProps) {
  const [sessionStore] = useState(() => {
    const profileStore = getProfileStore();
    return createSessionStore({
      lessonId,
      graphVersion,
      graph,
      // The store reports the lesson's events, so every layout reports the same ones.
      onEvent: track,
      getSettings: () => {
        const { quiz } = profileStore.getState().profile;
        return {
          cadence: quiz.cadence,
          itemsPerCheck: quiz.itemsPerCheck,
          retryOnWrong: quiz.retryOnWrong,
        };
      },
    });
  });

  // Send events to the server while the lesson is open, and report changes to the settings.
  useEffect(() => {
    const stopSync = getEventQueue().start();
    const stopProfile = trackProfileChanges(getProfileStore(), { lessonId, graphVersion, track });
    return () => {
      stopProfile();
      stopSync();
    };
  }, [lessonId, graphVersion]);

  return (
    <SignClipsContext.Provider value={signClips}>
      <div className="mx-auto flex w-full max-w-5xl justify-end px-4 pt-4">
        <SettingsPanel />
      </div>
      <PrismRenderer graph={graph} sessionStore={sessionStore} />
    </SignClipsContext.Provider>
  );
}
