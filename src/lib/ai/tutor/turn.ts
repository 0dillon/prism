import { z } from "zod";
import type { KnowledgeGraph } from "@/lib/schemas/knowledge-graph";
import { streamText as defaultStream } from "../llm";
import {
  buildTutorPrompt,
  NOT_COVERED_MARKER,
  TUTOR_SYSTEM,
  type TutorTask,
} from "../prompts/tutor-turn";
import type { UsageCallback } from "../usage";

/**
 * One turn of the spoken tutor (PRD 5.6.3, P4-15): the learner asks something or asks for
 * more, and the tutor's reply streams back as text. The reply comes only from the lesson.
 * When the lesson does not hold the answer the model says so with a marker, and this code
 * replaces it with a fixed reply, so what the learner hears in that case never depends on
 * the model's wording.
 */

export const MAX_QUESTION_CHARS = 500;

export const TutorIntent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("question"),
    text: z.string().trim().min(1, "Ask a question.").max(MAX_QUESTION_CHARS),
  }),
  z.object({ type: z.literal("elaborate") }),
  z.object({ type: z.literal("example") }),
  z.object({ type: z.literal("simplify") }),
]);
export type TutorIntent = z.infer<typeof TutorIntent>;

export const TutorTurnRequest = z.object({
  lessonId: z.string().min(1).max(100),
  conceptId: z.string().min(1).max(100),
  intent: TutorIntent,
});
export type TutorTurnRequest = z.infer<typeof TutorTurnRequest>;

type GraphForTutor = Pick<KnowledgeGraph, "title" | "overview" | "sections" | "concepts">;
type Stream = typeof defaultStream;

/** What the tutor says when the lesson does not cover a question. */
export function notCoveredReply(currentTitle: string | undefined): string {
  const where = currentTitle ? ` We are on ${currentTitle}.` : "";
  return `The lesson doesn't cover that, so I can't answer it from here.${where} Ask me about this lesson, or say next to go on.`;
}

export const EMPTY_REPLY =
  "I'm not sure how to answer that. Try asking it another way, or say next to go on.";

/**
 * Streams the tutor's reply in pieces. The start of the reply is held back just long
 * enough to see whether it is the not-covered marker.
 */
export async function* tutorTurn(options: {
  graph: GraphForTutor;
  conceptId: string;
  intent: TutorIntent;
  onUsage?: UsageCallback;
  /** Override the model call. Used by tests. */
  stream?: Stream;
}): AsyncGenerator<string> {
  const { graph, conceptId, intent } = options;
  const current = graph.concepts.find((c) => c.id === conceptId);
  const stream = options.stream ?? defaultStream;
  const task: TutorTask = intent.type;

  const pieces = stream({
    system: TUTOR_SYSTEM,
    prompt: buildTutorPrompt({
      graph,
      conceptId,
      task,
      question: intent.type === "question" ? intent.text : undefined,
    }),
    tier: "fast",
    name: `tutor-${task}`,
    onUsage: options.onUsage,
  });

  let held = "";
  let decided = false;
  for await (const piece of pieces) {
    if (decided) {
      yield piece;
      continue;
    }
    held += piece;
    const start = held.trimStart();
    if (start.startsWith(NOT_COVERED_MARKER)) {
      yield notCoveredReply(current?.title);
      return; // the rest of the model's reply is never shown
    }
    // Still could be the marker: wait for more.
    if (start.length < NOT_COVERED_MARKER.length && NOT_COVERED_MARKER.startsWith(start)) continue;
    decided = true;
    yield held;
  }

  if (!decided) {
    // The stream ended while the start was still undecided.
    if (held.trim()) yield held;
    else yield EMPTY_REPLY;
  }
}
