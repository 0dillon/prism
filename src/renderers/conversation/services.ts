"use client";

import { createContext } from "react";
import type { IntentContext, SessionIntentResult } from "@/lib/ai/intents/session";
import { matchSessionIntent } from "@/lib/ai/intents/local";
import { streamTutorTurn } from "@/lib/ai/tutor/client";
import { gradeShortAnswerRemote } from "@/lib/ai/tutor/grade-client";
import type { TutorTurnRequest } from "@/lib/ai/tutor/turn";
import type { ParseNeedsResponse } from "@/lib/profile/parse-service";
import type { RenderProfile } from "@/lib/schemas/render-profile";
import type { SessionIntent } from "@/lib/schemas/intents";

/**
 * Everything the conversation needs from the network, behind one interface, so the
 * conversation itself can be tested and so the demo can supply its own (PRD 5.6.3).
 * Each can fail, and the conversation says so in words and carries on.
 */
export interface ConversationServices {
  /** Turns what the learner said into a command. Local phrases never leave the device. */
  resolveIntent(
    utterance: string,
    context: IntentContext & { lessonId: string },
  ): Promise<SessionIntent>;
  /** The tutor's reply, delivered as it is written. */
  tutorTurn(
    request: TutorTurnRequest,
    handlers: { onText: (piece: string) => void; signal: AbortSignal },
  ): Promise<string>;
  /** Grades a short answer. Rejects if grading is not available. */
  gradeShortAnswer(request: {
    lessonId: string;
    quizItemId: string;
    answer: string;
  }): Promise<{ correct: boolean; feedback?: string }>;
  /** Turns "make it easier to read" into new settings. */
  parseNeeds(text: string, profile: RenderProfile): Promise<ParseNeedsResponse>;
}

/** A guess for when the server cannot be reached: a longer utterance is probably a question. */
export function guessIntent(utterance: string): SessionIntent {
  const words = utterance.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3 || utterance.trim().endsWith("?")) {
    return { type: "question", text: utterance.trim() };
  }
  return { type: "unknown" };
}

export const networkServices: ConversationServices = {
  async resolveIntent(utterance, context) {
    const local = matchSessionIntent(utterance);
    if (local) return local;
    try {
      const { lessonId, ...rest } = context;
      const response = await fetch("/api/session/intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ utterance, lessonId, context: rest }),
      });
      if (!response.ok) return guessIntent(utterance);
      return ((await response.json()) as SessionIntentResult).intent;
    } catch {
      return guessIntent(utterance);
    }
  },

  tutorTurn: (request, { onText, signal }) => streamTutorTurn(request, { onText, signal }),

  gradeShortAnswer: (request) => gradeShortAnswerRemote(request),

  async parseNeeds(text, profile) {
    const response = await fetch("/api/profile/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, profile }),
    });
    if (!response.ok) throw new Error(`parse failed with status ${response.status}`);
    return (await response.json()) as ParseNeedsResponse;
  },
};

export const ConversationServicesContext = createContext<ConversationServices>(networkServices);
