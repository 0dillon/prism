import type { Metadata } from "next";
import { GuardianConsent } from "./GuardianConsent";

export const metadata: Metadata = {
  title: "Parent or guardian agreement",
  robots: { index: false, follow: false },
  // The link holds a secret, so it must not be sent on to other sites.
  referrer: "no-referrer",
};

export default async function ConsentPage({ params }: PageProps<"/consent/[token]">) {
  const { token } = await params;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">
        Is it okay for your child to use Prism?
      </h1>
      <p>
        Prism turns a lesson into the form that suits each learner: short cards, a conversation, a
        reading page or pictures and signs. A child under 13 needs a parent or guardian to agree
        before they can use it.
      </p>
      <ul className="list-disc ps-6">
        <li>
          Prism keeps the child&rsquo;s name, their answers in lessons and the settings they choose.
        </li>
        <li>It never asks for, or records, a diagnosis or a disability.</li>
        <li>
          Their teacher sees their progress. Their settings are seen only if the child chooses to
          share them.
        </li>
        <li>You can ask for a copy of their data, or for it to be deleted, at any time.</li>
      </ul>
      <GuardianConsent token={token} />
    </div>
  );
}
