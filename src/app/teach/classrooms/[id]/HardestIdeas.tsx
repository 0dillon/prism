import Link from "next/link";
import type { HardIdea } from "@/lib/classrooms/grid";

/**
 * The ideas that most answers got wrong, hardest first, each linking to the idea in the
 * lesson so the teacher can improve how it is explained.
 */
export function HardestIdeas({ lessonId, ideas }: { lessonId: string; ideas: HardIdea[] }) {
  if (ideas.length === 0) {
    return (
      <p className="text-muted">
        No one has answered a question yet, so there is nothing to rank. Check back after students
        have worked on the lesson.
      </p>
    );
  }
  return (
    <table className="w-full border-collapse text-start">
      <caption className="sr-only">
        Ideas ranked by the share of answers that were wrong, hardest first
      </caption>
      <thead>
        <tr>
          <th scope="col" className="border-line border-b p-2 text-start">
            Rank
          </th>
          <th scope="col" className="border-line border-b p-2 text-start">
            Idea
          </th>
          <th scope="col" className="border-line border-b p-2 text-start">
            Wrong answers
          </th>
          <th scope="col" className="border-line border-b p-2 text-start">
            Answers
          </th>
        </tr>
      </thead>
      <tbody>
        {ideas.map((idea, index) => (
          <tr key={idea.conceptId} className="border-line border-b">
            <td className="p-2">{index + 1}</td>
            <th scope="row" className="p-2 text-start font-semibold">
              <Link
                href={`/teach/lessons/${lessonId}/review#concept-${idea.conceptId}-heading`}
                className="underline"
              >
                {idea.title}
              </Link>
            </th>
            <td className="p-2">{Math.round(idea.errorRate * 100)}%</td>
            <td className="p-2">
              {idea.correct} right of {idea.attempts}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
