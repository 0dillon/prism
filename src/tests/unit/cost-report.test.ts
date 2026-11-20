import { describe, expect, it } from "vitest";
import {
  INGESTION_TARGET_USD,
  formatCostTable,
  summarizeCost,
  type JobUsage,
} from "@/lib/reports/cost";

const job = (lessonId: string, title: string, costUsd: number, tokens = 1000): JobUsage => ({
  lessonId,
  title,
  tokensIn: tokens,
  tokensOut: tokens / 10,
  costUsd,
});

describe("summarizeCost", () => {
  it("adds up retries per lesson and puts the most expensive first", () => {
    const summary = summarizeCost([
      job("a", "Water", 0.1),
      job("b", "Fractions", 0.3),
      job("a", "Water", 0.15),
    ]);
    expect(summary.lessons.map((l) => [l.title, l.runs, l.costUsd])).toEqual([
      ["Fractions", 1, 0.3],
      ["Water", 2, 0.25],
    ]);
    expect(summary.lessons[1].tokensIn).toBe(2000);
    expect(summary.totalUsd).toBeCloseTo(0.55);
    expect(summary.averageUsd).toBeCloseTo(0.275);
  });

  it("flags a lesson over the target per source", () => {
    expect(INGESTION_TARGET_USD).toBe(0.5);
    const summary = summarizeCost([
      job("a", "Big", 0.4),
      job("a", "Big", 0.2),
      job("b", "Small", 0.5),
    ]);
    expect(summary.lessons.find((l) => l.title === "Big")?.overTarget).toBe(true);
    expect(summary.lessons.find((l) => l.title === "Small")?.overTarget).toBe(false);
    expect(summary.overTarget).toBe(1);
  });

  it("is empty and zero with no jobs", () => {
    expect(summarizeCost([])).toEqual({ lessons: [], totalUsd: 0, averageUsd: 0, overTarget: 0 });
  });
});

describe("formatCostTable", () => {
  it("prints a header, a row per lesson and the totals", () => {
    const text = formatCostTable(summarizeCost([job("a", "Water", 0.25), job("b", "Huge", 0.75)]));
    const lines = text.split("\n");
    expect(lines[0]).toMatch(/^Lesson\s+Runs\s+Tokens in\s+Tokens out\s+Cost\s+Target$/);
    expect(lines[2]).toMatch(/^Huge\s+1\s+1000\s+100\s+\$0\.7500\s+OVER$/);
    expect(lines[3]).toMatch(/^Water\s+1\s+1000\s+100\s+\$0\.2500\s+ok$/);
    expect(text).toContain("2 lessons, total $1.0000, average $0.5000.");
    expect(text).toContain("1 over the $0.5000 target per source.");
    expect(text).toContain("Learner session cost is not recorded");
  });

  it("lines up the columns", () => {
    const lines = formatCostTable(
      summarizeCost([job("a", "A much longer title", 0.1), job("b", "Short", 0.2)]),
    ).split("\n");
    expect(new Set(lines.slice(0, 4).map((l) => l.length)).size).toBe(1);
  });

  it("names a lesson with no title", () => {
    expect(formatCostTable(summarizeCost([job("a", "", 0.1)]))).toContain("Untitled lesson");
  });

  it("says so when nothing has run", () => {
    expect(formatCostTable(summarizeCost([]))).toBe("No ingestion runs recorded yet.");
  });
});
