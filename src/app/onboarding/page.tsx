import type { Metadata } from "next";
import { safeNextPath } from "@/lib/auth/paths";
import { OnboardingFlow } from "./OnboardingFlow";

export const metadata: Metadata = { title: "Set up your lessons" };

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const { next } = await searchParams;
  const destination = safeNextPath(typeof next === "string" ? next : undefined);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">
          How would you like lessons to look?
        </h1>
        <p className="text-muted">
          Choose what feels right. You can change it any time, even in the middle of a lesson. Prism
          will never ask you why.
        </p>
      </div>
      <OnboardingFlow next={destination} />
    </div>
  );
}
