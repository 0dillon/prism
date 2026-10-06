import { z } from "zod";
import { gradeShortAnswerLocally } from "@/lib/quiz/grade";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";
import { generateStructured as defaultGenerate } from "../llm";
import { buildGradePrompt, GRADE_SYSTEM } from "../prompts/grade-answer";
import type { UsageCallback } from "../usage";

/**
 * Grades a short answer (PRD 5.6.3, P4-19). An answer that matches the model answer or an
 * accepted phrasing is marked right without a model call. Anything else goes to the fast
 * model, which can credit different words for the same idea. Only a "correct" verdict
 * counts as correct: a partly right answer is not, but the feedback says what was right.
 */

export const MAX_ANSWER_CHARS = 500;

const GradeOutput = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  feedback: z.string(),
});

export const GradeRequest = z.object({
  lessonId: z.string().min(1).max(100),
  quizItemId: z.string().min(1).max(100),
  answer: z.string().trim().min(1, "Give an answer.").max(MAX_ANSWER_CHARS),
});
export type GradeRequest = z.infer<typeof GradeRequest>;

export interface ShortAnswerResult {
  correct: boolean;
  /** The kind of result, so the learner can be told "partly right". */
  verdict: "correct" | "partial" | "incorrect";
  feedback: string;
  /** Whether the local match decided it, with no model call. */
  local: boolean;
}

type Generate = typeof defaultGenerate;

export async function gradeShortAnswer(options: {
  item: QuizItem;
  answer: string;
  onUsage?: UsageCallback;
  /** Override the model call. Used by tests. */
  generate?: Generate;
}): Promise<ShortAnswerResult> {
  const { item } = options;
  const answer = options.answer.trim().slice(0, MAX_ANSWER_CHARS);

  if (gradeShortAnswerLocally(item, answer).correct) {
    return { correct: true, verdict: "correct", feedback: "That's right.", local: true };
  }
  if (!answer) {
    return {
      correct: false,
      verdict: "incorrect",
      feedback: `The answer is ${item.answer}.`,
      local: true,
    };
  }

  const generate = options.generate ?? defaultGenerate;
  const output = await generate({
    schema: GradeOutput,
    system: GRADE_SYSTEM,
    prompt: buildGradePrompt(item, answer),
    tier: "fast",
    name: "grade-short-answer",
    onUsage: options.onUsage,
  });

  const feedback = output.feedback.trim() || defaultFeedback(output.verdict, item);
  return { correct: output.verdict === "correct", verdict: output.verdict, feedback, local: false };
}

function defaultFeedback(verdict: ShortAnswerResult["verdict"], item: QuizItem): string {
  if (verdict === "correct") return "That's right.";
  if (verdict === "partial")
    return `You are on the right track. The full answer is ${item.answer}.`;
  return `Not quite. The answer is ${item.answer}.`;
}
