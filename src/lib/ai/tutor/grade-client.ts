import type { ShortAnswerGrade } from "@/renderers/shared/QuizBlock";

/**
 * Asks the server to grade a short answer. The result has the shape the quiz block expects.
 * It rejects on any failure, so the caller can fall back to the strict local check.
 */
export async function gradeShortAnswerRemote(
  request: { lessonId: string; quizItemId: string; answer: string },
  fetchFn: typeof fetch = fetch,
): Promise<ShortAnswerGrade & { verdict: "correct" | "partial" | "incorrect" }> {
  const response = await fetchFn("/api/tutor/grade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`grading failed with status ${response.status}`);
  const json = (await response.json()) as {
    correct?: unknown;
    verdict?: unknown;
    feedback?: unknown;
  };
  if (
    typeof json.correct !== "boolean" ||
    (json.verdict !== "correct" && json.verdict !== "partial" && json.verdict !== "incorrect")
  ) {
    throw new Error("grading returned something unexpected");
  }
  return {
    correct: json.correct,
    verdict: json.verdict,
    feedback: typeof json.feedback === "string" ? json.feedback : undefined,
  };
}
