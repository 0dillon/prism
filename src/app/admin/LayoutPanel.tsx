import { MIN_GROUP_SIZE, type LayoutShare } from "@/lib/admin/dashboard";
import { countOf } from "@/renderers/shared/lesson";

const NAMES: Record<LayoutShare["layout"], string> = {
  reader: "Reading page",
  cards: "Cards",
  conversation: "Conversation",
  visual: "Pictures and signs",
};

/**
 * How learners across the whole school view lessons. This is never shown for a class or a
 * person, and a group of fewer than five is never counted, because the way someone needs to
 * see a lesson can reveal something about them.
 */
export function LayoutPanel({ layouts }: { layouts: LayoutShare[] }) {
  const anyShown = layouts.some((l) => l.learners !== null);
  return (
    <div className="flex flex-col gap-3">
      {anyShown ? (
        <table className="w-full max-w-2xl border-collapse text-start">
          <caption className="sr-only">
            Learners by how they view lessons, across the school
          </caption>
          <thead>
            <tr>
              <th scope="col" className="border-line border-b p-2 text-start">
                How lessons are viewed
              </th>
              <th scope="col" className="border-line border-b p-2 text-start">
                Learners
              </th>
              <th scope="col" className="border-line border-b p-2 text-start">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {layouts.map((l) => (
              <tr key={l.layout} className="border-line border-b">
                <th scope="row" className="p-2 text-start font-semibold">
                  {NAMES[l.layout]}
                </th>
                {l.learners === null ? (
                  <td colSpan={2} className="p-2">
                    Fewer than {MIN_GROUP_SIZE} learners
                  </td>
                ) : (
                  <>
                    <td className="p-2">{countOf(l.learners, "learner")}</td>
                    <td className="p-2">{Math.round((l.share ?? 0) * 100)}%</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>
          There are not enough learners yet to show this. Every group needs at least{" "}
          {MIN_GROUP_SIZE} learners before it is counted.
        </p>
      )}
      <p className="text-muted text-sm">
        A learner is counted once for each way they have viewed lessons. Groups with fewer than{" "}
        {MIN_GROUP_SIZE} learners are never shown, and the shares are worked out only from the
        groups that are shown. These numbers are for the whole school and are never broken down by
        class or person.
      </p>
    </div>
  );
}
