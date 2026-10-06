import Link from "next/link";

export const metadata = { title: "No access" };

/** Shown, with a 403 status, when a signed-in user opens something they may not see. */
export default function Forbidden() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">
        You do not have access to this lesson
      </h1>
      <p>
        It may not be published yet, or it may not have been shared with you. If you think this is a
        mistake, ask the person who gave you the link.
      </p>
      <p>
        <Link href="/learn" className="font-semibold underline">
          Back to your lessons
        </Link>
      </p>
    </div>
  );
}
