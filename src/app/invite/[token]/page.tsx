import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AcceptInvite } from "./AcceptInvite";

export const metadata: Metadata = { title: "Join your school", robots: { index: false } };

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Join your school</h1>
      <p className="text-muted">
        You are signed in as {data.user.email}. The invitation only works for the email address it
        was sent to.
      </p>
      <AcceptInvite token={token} />
    </div>
  );
}
