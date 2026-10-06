"use client";

import { useState } from "react";
import { getProfileStore } from "@/lib/profile/store";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { createSessionStore } from "@/lib/session/store";
import { PrismRenderer } from "@/renderers/PrismRenderer";

interface LessonPlayerProps {
  lessonId: string;
  graphVersion: number;
  graph: KnowledgeGraph;
}

/**
 * Mounts one learner session for a lesson and hands it to PrismRenderer. The session
 * reads the quiz cadence from the profile each time, so changing it takes effect at once.
 */
export function LessonPlayer({ lessonId, graphVersion, graph }: LessonPlayerProps) {
  const [sessionStore] = useState(() => {
    const profileStore = getProfileStore();
    return createSessionStore({
      lessonId,
      graphVersion,
      graph,
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

  return <PrismRenderer graph={graph} sessionStore={sessionStore} />;
}
