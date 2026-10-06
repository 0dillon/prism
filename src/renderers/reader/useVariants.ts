"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { requestVariant, type VariantResponse } from "@/lib/lessons/variants-client";
import { track } from "@/lib/session/events";
import type { RenderProfile } from "@/lib/schemas/render-profile";

export type ReadingLevel = RenderProfile["content"]["readingLevel"];

/** From the wording the learner started with to the simplest, one step at a time. */
export const LEVEL_LADDER: readonly ReadingLevel[] = ["original", "plain", "simple"];

export const LEVEL_LABELS: Record<ReadingLevel, string> = {
  original: "Original wording",
  plain: "Plainer wording",
  simple: "Very simple wording",
};

export type VariantStatus = "idle" | "loading" | "error";

interface UseVariantsOptions {
  lessonId: string;
  graphVersion: number;
  /** The level the learner's profile asks for, for every concept they have not changed. */
  defaultLevel: ReadingLevel;
  /** Concepts on screen. Their variants are fetched when the level asks for one. */
  conceptIds: readonly string[];
  /** Replaces the network call. Used by tests. */
  request?: typeof requestVariant;
}

export interface VariantsApi {
  levelFor(conceptId: string): ReadingLevel;
  /** The rewritten body for a concept at its current level, once it has arrived. */
  bodyFor(conceptId: string): string | undefined;
  statusFor(conceptId: string): VariantStatus;
  errorFor(conceptId: string): string | undefined;
  /** Moves a concept one step up the ladder: original, then plain, then very simple. */
  simpler(conceptId: string): void;
  original(conceptId: string): void;
  retry(conceptId: string): void;
  canSimplify(conceptId: string): boolean;
}

const cacheKey = (conceptId: string, level: ReadingLevel) => `${conceptId}:${level}`;

/**
 * Reading-level variants for the reader (PRD 5.5). A concept shows the level the learner
 * chose for it with "Simpler", or else the level in their profile. The text of a level is
 * fetched once, kept for the visit, and swapped in place; until it arrives the original is
 * shown, so the page never goes blank.
 */
export function useVariants({
  lessonId,
  graphVersion,
  defaultLevel,
  conceptIds,
  request = requestVariant,
}: UseVariantsOptions): VariantsApi {
  const [overrides, setOverrides] = useState<Record<string, ReadingLevel>>({});
  const [bodies, setBodies] = useState<Record<string, VariantResponse>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<Record<string, true>>({});
  // Requests already sent, so a re-render never asks twice.
  const asked = useRef(new Set<string>());

  const levelFor = useCallback(
    (id: string): ReadingLevel => overrides[id] ?? defaultLevel,
    [overrides, defaultLevel],
  );

  const fetchVariant = useCallback(
    (conceptId: string, level: ReadingLevel) => {
      if (level === "original") return;
      const key = cacheKey(conceptId, level);
      if (asked.current.has(key)) return;
      asked.current.add(key);
      setLoading((current) => ({ ...current, [key]: true }));
      setErrors(({ [key]: _gone, ...rest }) => rest);
      track({
        type: "concept_variant_requested",
        lessonId,
        graphVersion,
        conceptId,
        layout: "reader",
      });
      request({ lessonId, conceptId, readingLevel: level })
        .then((variant) => setBodies((current) => ({ ...current, [key]: variant })))
        .catch((error: unknown) => {
          // Forget the request so Try again can send it once more.
          asked.current.delete(key);
          setErrors((current) => ({
            ...current,
            [key]: error instanceof Error ? error.message : "We could not make that simpler.",
          }));
        })
        .finally(() => setLoading(({ [key]: _done, ...rest }) => rest));
    },
    [lessonId, graphVersion, request],
  );

  // Fetch what the screen needs: each concept on the page, at its level.
  useEffect(() => {
    for (const id of conceptIds) {
      const level = overrides[id] ?? defaultLevel;
      const key = cacheKey(id, level);
      // A failed fetch is not retried on its own: that would loop. The learner presses Try again.
      if (level !== "original" && !bodies[key] && !errors[key]) fetchVariant(id, level);
    }
  }, [conceptIds, overrides, defaultLevel, bodies, errors, fetchVariant]);

  return {
    levelFor,
    bodyFor: (id) => {
      const level = levelFor(id);
      return level === "original" ? undefined : bodies[cacheKey(id, level)]?.body;
    },
    statusFor: (id) => {
      const key = cacheKey(id, levelFor(id));
      if (loading[key]) return "loading";
      return errors[key] ? "error" : "idle";
    },
    errorFor: (id) => errors[cacheKey(id, levelFor(id))],
    simpler: (id) => {
      const next = LEVEL_LADDER[Math.min(LEVEL_LADDER.indexOf(levelFor(id)) + 1, 2)];
      setOverrides((current) => ({ ...current, [id]: next }));
    },
    original: (id) => setOverrides((current) => ({ ...current, [id]: "original" })),
    retry: (id) => {
      const level = levelFor(id);
      const key = cacheKey(id, level);
      setErrors(({ [key]: _gone, ...rest }) => rest);
    },
    canSimplify: (id) => levelFor(id) !== "simple",
  };
}
