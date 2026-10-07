import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { InviteForm } from "./InviteForm";
import { listPrincipalOrgs } from "@/lib/orgs/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "School" };

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in?next=%2Fadmin");

  const orgs = await listPrincipalOrgs(supabase, data.user.id);
  if (orgs.length === 0) redirect("/admin/setup");

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-3xl font-bold">{orgs[0].name}</h1>
      <InviteForm orgId={orgs[0].id} />
      <p className="text-muted">
        <Link href="/admin/setup" className="underline">
          Set up another school
        </Link>
      </p>
    </div>
  );
}
