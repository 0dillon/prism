"use client";

import { createContext } from "react";

/**
 * Verified sign clips for the lesson being shown, keyed by concept id (PRD 5.6.4). The
 * lesson page fills this with the clips a teacher has verified and the server has signed
 * URLs for; the renderer only reads it. With none (the demo, or a lesson with no clips)
 * every key term is shown fingerspelled instead.
 */
export interface LearnerSignClip {
  gloss: string;
  /** A short-lived URL for the video. */
  url: string;
  license: string;
  signerCredit: string | null;
}

export type SignClipMap = Readonly<Record<string, LearnerSignClip>>;

export const SignClipsContext = createContext<SignClipMap>({});

/** The honest statement shown wherever signs appear: key terms only, not a translation. */
export const SIGN_NOTICE = "Signs are shown for key terms. This is not a full translation.";
