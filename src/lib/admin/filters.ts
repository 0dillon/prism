import { z } from "zod";

/**
 * The principal dashboard's filters (PRD P6-11). They live in the URL, so a filtered view can
 * be reloaded, bookmarked and shared. Anything in the URL that is not valid is ignored, so a
 * hand-edited link never breaks the page; it falls back to the default.
 */

export interface DashboardFilters {
  grade: string | null;
  subject: string | null;
  teacherId: string | null;
  /** First and last day of the activity range, as YYYY-MM-DD. */
  from: string;
  to: string;
}

export type RawSearch = Record<string, string | string[] | undefined>;

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** True for a real calendar date written as YYYY-MM-DD (so not 31 February). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function defaultRange(now: number): { from: string; to: string } {
  return { from: isoDate(now - (DEFAULT_RANGE_DAYS - 1) * DAY_MS), to: isoDate(now) };
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const text = (value: string | string[] | undefined, max: number): string | null => {
  const v = first(value)?.trim();
  return v && v.length <= max ? v : null;
};

export function parseFilters(search: RawSearch, now: number): DashboardFilters {
  const fallback = defaultRange(now);
  const from = first(search.from);
  const to = first(search.to);
  let range = fallback;
  if (from && to && isCalendarDate(from) && isCalendarDate(to) && from <= to) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (days <= MAX_RANGE_DAYS) range = { from, to };
  }
  const teacher = first(search.teacher);
  return {
    grade: text(search.grade, 40),
    subject: text(search.subject, 80),
    teacherId: teacher && z.uuid().safeParse(teacher).success ? teacher : null,
    ...range,
  };
}

/** The URL query for a set of filters. A value that is the default is left out. */
export function filtersToQuery(filters: DashboardFilters, now: number): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.grade) query.set("grade", filters.grade);
  if (filters.subject) query.set("subject", filters.subject);
  if (filters.teacherId) query.set("teacher", filters.teacherId);
  const fallback = defaultRange(now);
  if (filters.from !== fallback.from || filters.to !== fallback.to) {
    query.set("from", filters.from);
    query.set("to", filters.to);
  }
  return query;
}

export function hasActiveFilters(filters: DashboardFilters, now: number): boolean {
  return filtersToQuery(filters, now).size > 0;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Oct 2026" from "2026-10-01". */
export function formatDay(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** "1 Oct 2026 to 30 Oct 2026". */
export function rangeLabel(filters: DashboardFilters): string {
  return `${formatDay(filters.from)} to ${formatDay(filters.to)}`;
}

/**
 * The filters from the page's URL, the current clock folded in. Kept here so a page does not
 * read the clock itself: pages must give the same output for the same input.
 */
export function currentFilters(search: RawSearch): {
  filters: DashboardFilters;
  active: boolean;
  query: string;
} {
  const now = Date.now();
  const filters = parseFilters(search, now);
  const query = filtersToQuery(filters, now);
  return { filters, active: query.size > 0, query: query.toString() };
}
