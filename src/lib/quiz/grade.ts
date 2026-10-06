import { normalizeForMatch } from "@/lib/ai/ingestion/text";
import type { QuizItem } from "@/lib/schemas/knowledge-graph";

/**
 * Local grading (PRD 6.2: "MCQ and true/false graded locally with no LLM"). Multiple
 * choice and true/false are exact. Short answers get a strict local check against the
 * model answer and the accepted phrasings, which is also the fallback when the LLM
 * grader is unavailable (PRD 6.5).
 */

export interface Grade {
  correct: boolean;
  /** The answer to show the learner when they were wrong. */
  correctAnswer: string;
}

export function gradeChoice(item: QuizItem, chosen: string): Grade {
  return { correct: chosen === item.answer, correctAnswer: item.answer };
}

/** Strips punctuation and ignores case, accents and spacing, so "Condensation!" matches "condensation". */
export function normalizeAnswer(text: string): string {
  return normalizeForMatch(text)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function gradeShortAnswerLocally(item: QuizItem, given: string): Grade {
  const answer = normalizeAnswer(given);
  const accepted = [item.answer, ...item.acceptable].map(normalizeAnswer).filter(Boolean);
  return { correct: answer.length > 0 && accepted.includes(answer), correctAnswer: item.answer };
}

/** Grades any item locally. Short answers use the strict local check. */
export function gradeLocally(item: QuizItem, given: string): Grade {
  return item.type === "short_answer"
    ? gradeShortAnswerLocally(item, given)
    : gradeChoice(item, given);
}
