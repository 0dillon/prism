import type { UserClient } from "@/lib/api/http";

export interface OrgSummary {
  id: string;
  name: string;
}

/** The organizations the user runs as principal. Row-level security limits this to their own. */
export async function listPrincipalOrgs(user: UserClient, userId: string): Promise<OrgSummary[]> {
  const memberships = await user
    .from("org_memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("role", "principal");
  const ids = (memberships.data ?? []).map((m) => m.org_id);
  if (ids.length === 0) return [];
  const orgs = await user.from("organizations").select("id, name").in("id", ids).order("name");
  return orgs.data ?? [];
}
