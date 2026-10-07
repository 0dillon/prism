import Link from "next/link";
import type { FilterOptions } from "@/lib/admin/dashboard";
import type { DashboardFilters } from "@/lib/admin/filters";

/**
 * Filters as a plain form that submits with GET, so the choices are in the URL and survive a
 * reload, a bookmark or a shared link. It works without JavaScript.
 */
export function Filters({
  options,
  filters,
  orgId,
  multipleOrgs,
  active,
}: {
  options: FilterOptions;
  filters: DashboardFilters;
  orgId: string;
  multipleOrgs: boolean;
  /** Whether any filter differs from the default, so "Clear filters" is worth showing. */
  active: boolean;
}) {
  const select = (
    name: string,
    label: string,
    current: string | null,
    items: { value: string; label: string }[],
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`filter-${name}`} className="font-medium">
        {label}
      </label>
      <select
        id={`filter-${name}`}
        name={name}
        defaultValue={current ?? ""}
        className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
      >
        <option value="">All</option>
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </div>
  );
  const date = (name: "from" | "to", label: string) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`filter-${name}`} className="font-medium">
        {label}
      </label>
      <input
        id={`filter-${name}`}
        name={name}
        type="date"
        defaultValue={filters[name]}
        required
        className="border-line bg-background min-h-11 rounded-md border px-3 py-2"
      />
    </div>
  );

  return (
    <form method="get" action="/admin" aria-label="Filter classes" className="flex flex-col gap-4">
      {multipleOrgs ? <input type="hidden" name="org" value={orgId} /> : null}
      <div className="flex flex-wrap items-end gap-4">
        {select(
          "grade",
          "Grade",
          filters.grade,
          options.grades.map((g) => ({ value: g, label: g })),
        )}
        {select(
          "subject",
          "Subject",
          filters.subject,
          options.subjects.map((s) => ({ value: s, label: s })),
        )}
        {select(
          "teacher",
          "Teacher",
          filters.teacherId,
          options.teachers.map((t) => ({ value: t.id, label: t.name })),
        )}
        {date("from", "Activity from")}
        {date("to", "Activity to")}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          className="bg-accent text-accent-foreground min-h-11 min-w-11 cursor-pointer rounded-md border border-transparent px-4 py-2 font-semibold"
        >
          Apply filters
        </button>
        {active ? (
          <Link href={multipleOrgs ? `/admin?org=${orgId}` : "/admin"} className="underline">
            Clear filters
          </Link>
        ) : null}
      </div>
    </form>
  );
}
