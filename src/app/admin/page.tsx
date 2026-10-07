import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  describeEngagement,
  describeProgress,
  engagementPoints,
  progressPoints,
} from "@/lib/admin/charts";
import { loadDashboard } from "@/lib/admin/dashboard";
import { currentFilters, rangeLabel } from "@/lib/admin/filters";
import { listPrincipalOrgs } from "@/lib/orgs/queries";
import { loadOrgSpend } from "@/lib/orgs/spend";
import { createClient } from "@/lib/supabase/server";
import { BarChart } from "./BarChart";
import { ClassroomTable } from "./ClassroomTable";
import { Filters } from "./Filters";
import { InviteForm } from "./InviteForm";
import { LayoutPanel } from "./LayoutPanel";
import { SpendCard } from "./SpendCard";

export const metadata: Metadata = { title: "School" };

export const dynamic = "force-dynamic";

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) redirect("/sign-in?next=%2Fadmin");

  const orgs = await listPrincipalOrgs(supabase, data.user.id);
  if (orgs.length === 0) redirect("/admin/setup");

  const search = await searchParams;
  const requested = Array.isArray(search.org) ? search.org[0] : search.org;
  const org = orgs.find((o) => o.id === requested) ?? orgs[0];
  const { filters, active, query } = currentFilters(search);
  const [dashboard, spend] = await Promise.all([
    loadDashboard(supabase, org.id, filters),
    loadOrgSpend(supabase, org.id),
  ]);
  const range = rangeLabel(filters);
  const engagement = engagementPoints(dashboard.weekly);
  const progress = progressPoints(dashboard.weekly);
  const exportQuery = query ? `?${query}` : "";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{dashboard.orgName}</h1>
        {orgs.length > 1 ? (
          <nav aria-label="Your schools">
            <ul className="flex flex-wrap gap-2">
              {orgs.map((o) => (
                <li key={o.id}>
                  <Link
                    href={`/admin?org=${o.id}`}
                    aria-current={o.id === org.id ? "page" : undefined}
                    className={`inline-flex min-h-11 items-center rounded-md border px-3 ${
                      o.id === org.id
                        ? "bg-accent text-accent-foreground border-transparent"
                        : "border-line"
                    }`}
                  >
                    {o.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>

      <section aria-labelledby="classes-heading" className="flex flex-col gap-4">
        <h2 id="classes-heading" className="text-xl font-semibold">
          Classes
        </h2>
        <p className="text-muted">
          Every class is measured the same way: ideas mastered out of the ideas in its assigned
          lessons. Nothing here shows how any learner chose to view a lesson.
        </p>
        <Filters
          options={dashboard.options}
          filters={filters}
          orgId={org.id}
          multipleOrgs={orgs.length > 1}
          active={active}
        />
        <ClassroomTable rows={dashboard.rows} rangeLabel={range} />
        <p>
          <a
            href={`/api/orgs/${org.id}/export${exportQuery}`}
            className="font-semibold underline"
            download
          >
            Download these classes as a CSV file
          </a>
        </p>
      </section>

      <section aria-labelledby="trends-heading" className="flex flex-col gap-8">
        <h2 id="trends-heading" className="text-xl font-semibold">
          Across the school, week by week
        </h2>
        <p className="text-muted">
          These charts cover the whole school for {range}. The filters above change the table, not
          the charts.
        </p>
        <BarChart
          title="Learners active each week"
          valueHeading="Learners and time"
          summary={describeEngagement(engagement)}
          points={engagement}
        />
        <BarChart
          title="Ideas mastered each week"
          valueHeading="Ideas mastered"
          summary={describeProgress(progress)}
          points={progress}
        />
      </section>

      <section aria-labelledby="layout-heading" className="flex flex-col gap-3">
        <h2 id="layout-heading" className="text-xl font-semibold">
          How lessons are viewed across the school
        </h2>
        <LayoutPanel layouts={dashboard.layouts} />
      </section>

      <SpendCard orgId={org.id} spend={spend} />

      <InviteForm orgId={org.id} />
      <p className="text-muted">
        <Link href="/admin/setup" className="underline">
          Set up another school
        </Link>
      </p>
    </div>
  );
}
