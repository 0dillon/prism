import { z } from "zod";
import { SessionIntent } from "@/lib/schemas/intents";
import { generateStructured as defaultGenerate, StructuredOutputError } from "../llm";
import { buildSessionIntentPrompt, SESSION_INTENT_SYSTEM } from "../prompts/session-intent";
import type { UsageCallback } from "../usage";
import { matchSessionIntent } from "./local";

/**
 * In-session commands (PRD 5.4 B, task P3-15). Common phrases are matched locally. What is
 * left goes to the fast model, which only picks a command. This code turns that pick into a
 * validated SessionIntent, and anything it cannot trust becomes `unknown`.
 */

export const MAX_UTTERANCE_CHARS = 500;
const MAX_TITLES = 100;

export const IntentContext = z.object({
  lessonTitle: z.string().max(200).optional(),
  currentConcept: z.string().max(200).optional(),
  conceptTitles: z.array(z.string().max(200)).max(MAX_TITLES).optional(),
  pendingQuestion: z.string().max(500).optional(),
  paused: z.boolean().optional(),
});
export type IntentContext = z.infer<typeof IntentContext>;

export const SessionIntentRequest = z.object({
  utterance: z
    .string()
    .trim()
    .min(1, "Say or type what you would like to do.")
    .max(MAX_UTTERANCE_CHARS, `Please use ${MAX_UTTERANCE_CHARS} characters or fewer.`),
  context: IntentContext.optional(),
});
export type SessionIntentRequest = z.infer<typeof SessionIntentRequest>;

export const INTENT_TYPES = [
  "next",
  "previous",
  "repeat",
  "simplify",
  "elaborate",
  "example",
  "quiz_me",
  "answer",
  "pause",
  "resume",
  "where_am_i",
  "go_to",
  "set_rate",
  "change_profile",
  "question",
  "unknown",
] as const;

/**
 * What the model returns: one flat object, because Gemini handles a plain object with
 * optional fields better than a union. The fields a type does not use are left out.
 */
export const IntentOutput = z.object({
  type: z.enum(INTENT_TYPES),
  value: z.string().optional(),
  target: z.string().optional(),
  direction: z.enum(["slower", "faster"]).optional(),
  request: z.string().optional(),
  text: z.string().optional(),
});
export type IntentOutput = z.infer<typeof IntentOutput>;

const UNKNOWN: SessionIntent = { type: "unknown" };

const clean = (value: string | undefined) => value?.trim() || undefined;

/** Turns the model's pick into a SessionIntent, or `unknown` if it is missing what it needs. */
export function toSessionIntent(
  output: IntentOutput,
  options: { utterance: string; context?: IntentContext },
): SessionIntent {
  const { utterance, context } = options;
  let intent: SessionIntent;
  switch (output.type) {
    case "answer": {
      // An answer only makes sense when a question is waiting.
      const value = clean(output.value);
      intent = value && context?.pendingQuestion ? { type: "answer", value } : UNKNOWN;
      break;
    }
    case "go_to": {
      const target = clean(output.target);
      if (!target) {
        intent = UNKNOWN;
        break;
      }
      const exact = context?.conceptTitles?.find(
        (title) => title.trim().toLowerCase() === target.toLowerCase(),
      );
      intent = { type: "go_to", target: exact?.trim() ?? target };
      break;
    }
    case "set_rate":
      intent = output.direction ? { type: "set_rate", direction: output.direction } : UNKNOWN;
      break;
    case "change_profile":
      intent = { type: "change_profile", request: clean(output.request) ?? utterance };
      break;
    case "question":
      intent = { type: "question", text: clean(output.text) ?? utterance };
      break;
    default:
      intent = { type: output.type };
  }
  // The schema is the last word, whatever the model sent.
  const parsed = SessionIntent.safeParse(intent);
  return parsed.success ? parsed.data : UNKNOWN;
}

export interface SessionIntentResult {
  intent: SessionIntent;
  /** Whether the local matcher or the model decided. */
  source: "local" | "model";
}

type Generate = typeof defaultGenerate;

export async function parseSessionIntent(options: {
  utterance: string;
  context?: IntentContext;
  onUsage?: UsageCallback;
  /** Override the LLM call. Used by tests. */
  generate?: Generate;
}): Promise<SessionIntentResult> {
  const utterance = options.utterance.trim().slice(0, MAX_UTTERANCE_CHARS);
  if (!utterance) return { intent: UNKNOWN, source: "local" };

  // Local phrases are whole commands that are not plausible answers, so they go first even
  // when a question is waiting. Everything else, including answers, is for the model.
  const local = matchSessionIntent(utterance);
  if (local) return { intent: local, source: "local" };

  const generate = options.generate ?? defaultGenerate;
  try {
    const output = await generate({
      schema: IntentOutput,
      system: SESSION_INTENT_SYSTEM,
      prompt: buildSessionIntentPrompt({ utterance, context: options.context }),
      tier: "fast",
      name: "session-intent",
      onUsage: options.onUsage,
    });
    return {
      intent: toSessionIntent(output, { utterance, context: options.context }),
      source: "model",
    };
  } catch (error) {
    // A reply that will not validate is not worth failing the lesson over.
    if (error instanceof StructuredOutputError) return { intent: UNKNOWN, source: "model" };
    throw error;
  }
}
