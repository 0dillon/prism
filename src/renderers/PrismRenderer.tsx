"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StoreApi } from "zustand/vanilla";
import { announce } from "@/lib/a11y/live-region";
import { getEventQueue } from "@/lib/session/events";
import type { ProfilePatch } from "@/lib/profile/merge";
import {
  getProfileStore,
  useProfile,
  useProfileHydration,
  type ProfileStore,
} from "@/lib/profile/store";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { useSession, useSessionHydration, type SessionStore } from "@/lib/session/store";
import { LAYOUT_LABELS, prefetchRenderers, renderers } from "./registry";
import { useProfileStyles } from "./shared/useProfileStyles";
import { RENDERER_HEADING_ATTRIBUTE, type SessionActions } from "./types";

interface PrismRendererProps {
  graph: KnowledgeGraph;
  sessionStore: StoreApi<SessionStore>;
  profileStore?: StoreApi<ProfileStore>;
}

/**
 * Mounts inside the Suspense boundary beside the renderer, so its effect runs only once the
 * renderer has loaded and committed. If `active`, it reports that the new renderer is ready.
 */
function Ready({ active, onReady }: { active: boolean; onReady: () => void }) {
  useEffect(() => {
    if (active) onReady();
  }, [active, onReady]);
  return null;
}

/**
 * Chooses the renderer for the learner's layout and gives it the lesson, the session and
 * the profile (PRD 5.5). Changing the profile swaps the component and leaves the session
 * alone, so the learner keeps their concept, quiz state and progress. A switch makes no
 * network request: renderer bundles are prefetched after the first paint. After a switch,
 * focus moves to the new renderer's heading and a polite message says what changed.
 */
export function PrismRenderer({
  graph,
  sessionStore,
  profileStore = getProfileStore(),
}: PrismRendererProps) {
  useProfileHydration(profileStore);
  useSessionHydration(sessionStore);

  const profile = useProfile((state) => state.profile, profileStore);
  const session = useSession(sessionStore, (state) => state.session);

  const actions = useMemo<SessionActions>(() => {
    const s = sessionStore.getState();
    return {
      start: s.start,
      next: s.next,
      previous: s.previous,
      requestQuiz: s.requestQuiz,
      answer: s.answer,
      continue: s.continue,
      goTo: s.goTo,
      restart: s.restart,
    };
  }, [sessionStore]);

  const updateProfile = useCallback(
    (patch: ProfilePatch) => {
      try {
        profileStore
          .getState()
          .applyPatch(patch, { coalesceKey: `renderer:${Object.keys(patch)}` });
      } catch {
        // A renderer only offers valid values, so a refused change leaves the profile as it was.
      }
    },
    [profileStore],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  // Prefetch the other renderers once the page has painted, off the critical path.
  useEffect(() => {
    const run = () => prefetchRenderers();
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run);
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(run, 200);
    return () => window.clearTimeout(handle);
  }, []);

  // Notice a layout change while rendering, so focus and the announcement can happen once
  // the new renderer is ready. (Deriving state from props this way is the React-approved pattern.)
  const [shownLayout, setShownLayout] = useState(profile.layout);
  const [switchPending, setSwitchPending] = useState(false);
  if (shownLayout !== profile.layout) {
    setShownLayout(profile.layout);
    setSwitchPending(true);
  }

  const onRendererReady = useCallback(() => {
    rootRef.current?.querySelector<HTMLElement>(`[${RENDERER_HEADING_ATTRIBUTE}]`)?.focus();
    announce(`Switched to the ${LAYOUT_LABELS[profile.layout]} view.`);
    setSwitchPending(false);
  }, [profile.layout]);

  // Events are stamped with the layout on screen (product analytics only, PRD 5.7).
  useEffect(() => {
    getEventQueue().setLayout(profile.layout);
  }, [profile.layout]);

  const styles = useProfileStyles(profile);
  const Renderer = renderers[profile.layout];

  return (
    <div ref={rootRef} data-layout={profile.layout} {...styles}>
      <Suspense fallback={<p role="status">Loading the {LAYOUT_LABELS[profile.layout]} view…</p>}>
        <Renderer
          key={profile.layout}
          graph={graph}
          session={session}
          profile={profile}
          actions={actions}
          updateProfile={updateProfile}
        />
        <Ready key={`ready-${profile.layout}`} active={switchPending} onReady={onRendererReady} />
      </Suspense>
    </div>
  );
}
