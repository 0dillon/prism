import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { loadDeletionState } from "@/lib/consent/data-rights";
import { loadConsent } from "@/lib/consent/service";
import { createClient } from "@/lib/supabase/server";
import { AccountActions } from "./AccountActions";

export const metadata: Metadata = { title: "Your data" };

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in?next=%2Faccount");

  const [consent, deletion] = await Promise.all([
    loadConsent(supabase, data.user.id),
    loadDeletionState(supabase, data.user.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6">
      <div className="flex flex-col gap-1">
        <p>
          <Link href="/learn" className="underline">
            Back to my lessons
          </Link>
        </p>
        <h1 className="text-3xl font-bold">Your data</h1>
        <p className="text-muted">Signed in as {data.user.email}.</p>
      </div>
      {consent.status === "pending" ? (
        <p role="status" className="border-line rounded-lg border p-3">
          Your account is paused until a parent or guardian agrees.
        </p>
      ) : null}
      <AccountActions deletionRequestedOn={deletion.requestedAt} />
    </div>
  );
}
