import type { WeeklyPoint } from "./dashboard";
import type { BarPoint } from "@/app/admin/BarChart";
import { formatActiveTime } from "@/renderers/shared/lesson";

/**
 * Turns the weekly series into chart points and the sentence that describes each chart
 * (PRD P6-12). Every chart has a sentence, a labelled value on every bar and a table, so none
 * of it depends on seeing the picture.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "5 Oct" from "2026-10-05". The weeks are calendar dates, so no time zone is involved. */
export function weekLabel(iso: string): string {
  const [, month, day] = iso.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function engagementPoints(weekly: WeeklyPoint[]): BarPoint[] {
  return weekly.map((w) => ({
    label: weekLabel(w.weekStart),
    value: w.activeLearners,
    text: `${plural(w.activeLearners, "learner")}, ${formatActiveTime(w.activeSeconds * 1000)}`,
  }));
}

export function progressPoints(weekly: WeeklyPoint[]): BarPoint[] {
  return weekly.map((w) => ({
    label: weekLabel(w.weekStart),
    value: w.masteredIdeas,
    text: plural(w.masteredIdeas, "idea"),
  }));
}

function describeSeries(points: BarPoint[], what: string, unit: string): string {
  if (points.length === 0) return `No weeks to show for ${what}.`;
  const total = points.reduce((sum, p) => sum + p.value, 0);
  if (total === 0) return `No ${what} in these ${plural(points.length, "week")}.`;
  const highest = points.reduce((best, p) => (p.value > best.value ? p : best));
  const lowest = points.reduce((best, p) => (p.value < best.value ? p : best));
  const average = Math.round(total / points.length);
  const spread =
    highest.value === lowest.value
      ? `It was ${plural(highest.value, unit)} every week.`
      : `The most was ${plural(highest.value, unit)} in the week starting ${highest.label}, and the fewest was ${lowest.value} in the week starting ${lowest.label}.`;
  return `${what[0].toUpperCase()}${what.slice(1)} over ${plural(points.length, "week")}, from the week starting ${points[0].label}. ${spread} The average is ${average} a week.`;
}

export const describeEngagement = (points: BarPoint[]) =>
  describeSeries(points, "learners active", "learner");

export const describeProgress = (points: BarPoint[]) =>
  describeSeries(points, "ideas mastered", "idea");
