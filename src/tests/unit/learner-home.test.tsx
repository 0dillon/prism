// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadLearnerHome, progressFraction } from "@/lib/lessons/home-service";
import { expectNoAxeViolations } from "../a11y";
import { FakeSupabase } from "../fixtures/fake-supabase";

const ME = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const OWNER = "22222222-2222-4222-8222-222222222222";
const L1 = "11111111-1111-4111-8111-111111111111";
const L2 = "55555555-5555-4555-8555-555555555555";
const DRAFT = "66666666-6666-4666-8666-666666666666";

const mocks = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(to), { to });
  },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    ...(mocks.db as FakeSupabase).asUser(mocks.userId ?? "00000000-0000-4000-8000-000000000000"),
    auth: {
      getUser: async () =>
        mocks.userId ? { data: { user: { id: mocks.userId } } } : { data: { user: null } },
    },
  }),
}));

import LearnerHomePage from "@/app/learn/page";

let db: FakeSupabase;

type Mastery = [user: string, lesson: string, concept: string, status: string];

/** Assigns a lesson to a class the learner is in. */
function assign(lesson: string, dueAt: string | null = null, classroom = "class-1") {
  db.tables.assignments.push({ classroom_id: classroom, lesson_id: lesson, due_at: dueAt });
}

function seed(mastery: Mastery[] = [], due: Partial<Record<string, string | null>> = {}) {
  db.tables.lessons.push(
    {
      id: L1,
      title: "The Water Cycle",
      status: "published",
      owner_id: OWNER,
      created_at: "2026-10-02",
    },
    { id: L2, title: "Fractions", status: "published", owner_id: OWNER, created_at: "2026-10-01" },
    {
      id: DRAFT,
      title: "Unfinished",
      status: "needs_review",
      owner_id: OWNER,
      created_at: "2026-10-03",
    },
  );
  for (const lesson of [L1, L2, DRAFT]) assign(lesson, due[lesson] ?? null);
  for (const [lesson, ids] of [
    [L1, ["a", "b", "c", "d", "e"]],
    [L2, ["x", "y"]],
    [DRAFT, ["z"]],
  ] as const) {
    for (const id of ids) db.tables.concepts.push({ lesson_id: lesson, id, retired: false });
  }
  for (const [user, lesson, concept, status] of mastery) {
    db.tables.concept_mastery.push({
      user_id: user,
      lesson_id: lesson,
      concept_id: concept,
      status,
    });
  }
}

beforeEach(() => {
  db = new FakeSupabase();
  mocks.db = db;
  mocks.userId = ME;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadLearnerHome", () => {
  it("shows mastered ideas over the ideas in the lesson, for the seed learner", async () => {
    seed([
      [ME, L1, "a", "mastered"],
      [ME, L1, "b", "mastered"],
      [ME, L1, "c", "in_progress"],
      [ME, L2, "x", "mastered"],
      [ME, L2, "y", "mastered"],
    ]);
    const home = await loadLearnerHome(db.asUser(ME));
    const byTitle = Object.fromEntries(home.map((p) => [p.title, p]));
    expect(byTitle["The Water Cycle"]).toMatchObject({
      totalConcepts: 5,
      masteredConcepts: 2,
      startedConcepts: 3,
      status: "in_progress",
    });
    expect(byTitle["Fractions"]).toMatchObject({
      totalConcepts: 2,
      masteredConcepts: 2,
      status: "complete",
    });
    expect(progressFraction(byTitle["The Water Cycle"])).toBeCloseTo(0.4);
    expect(progressFraction(byTitle["Fractions"])).toBe(1);
  });

  it("lists only lessons assigned to the learner, however many are published", async () => {
    seed();
    db.tables.lessons.push({
      id: "99999999-9999-4999-8999-999999999999",
      title: "Not mine",
      status: "published",
      owner_id: OWNER,
      created_at: "2026-10-04",
    });
    const home = await loadLearnerHome(db.asUser(ME));
    expect(home.map((p) => p.title)).not.toContain("Not mine");
  });

  it("puts the soonest due date first, and lessons with no date after them", async () => {
    seed([], { [L1]: null, [L2]: "2026-10-20T23:59:59.000Z" });
    const home = await loadLearnerHome(db.asUser(ME));
    expect(home.map((p) => [p.title, p.dueAt])).toEqual([
      ["Fractions", "2026-10-20T23:59:59.000Z"],
      ["The Water Cycle", null],
    ]);
  });

  it("uses the earliest due date when two classes assign the same lesson", async () => {
    seed();
    assign(L1, "2026-12-01T23:59:59.000Z", "class-2");
    assign(L1, "2026-11-01T23:59:59.000Z", "class-3");
    const home = await loadLearnerHome(db.asUser(ME));
    expect(home.find((p) => p.lessonId === L1)?.dueAt).toBe("2026-11-01T23:59:59.000Z");
  });

  it("marks a lesson overdue only if it is past due and not finished", async () => {
    seed(
      [
        [ME, L2, "x", "mastered"],
        [ME, L2, "y", "mastered"],
      ],
      { [L1]: "2020-01-01T23:59:59.000Z", [L2]: "2020-01-01T23:59:59.000Z" },
    );
    const home = await loadLearnerHome(db.asUser(ME));
    expect(home.find((p) => p.lessonId === L1)?.overdue).toBe(true);
    expect(home.find((p) => p.lessonId === L2)?.overdue).toBe(false);
  });

  it("lists only published lessons, and marks lessons with no record as not started", async () => {
    seed();
    const home = await loadLearnerHome(db.asUser(ME));
    expect(home.map((p) => p.title)).toEqual(["The Water Cycle", "Fractions"]);
    expect(home.map((p) => p.status)).toEqual(["not_started", "not_started"]);
  });

  it("never counts another learner's progress", async () => {
    seed([
      [OTHER, L1, "a", "mastered"],
      [OTHER, L1, "b", "mastered"],
    ]);
    const home = await loadLearnerHome(db.asUser(ME));
    expect(home.find((p) => p.lessonId === L1)).toMatchObject({
      masteredConcepts: 0,
      startedConcepts: 0,
    });
  });

  it("ignores mastery of ideas no longer in the lesson, so progress cannot pass 100%", async () => {
    seed([
      [ME, L2, "x", "mastered"],
      [ME, L2, "y", "mastered"],
      [ME, L2, "removed-idea", "mastered"],
    ]);
    const fractions = (await loadLearnerHome(db.asUser(ME))).find((p) => p.lessonId === L2)!;
    expect(fractions.masteredConcepts).toBe(2);
    expect(progressFraction(fractions)).toBe(1);
  });

  it("does not count an idea the lesson has dropped", async () => {
    seed([[ME, L2, "x", "mastered"]]);
    db.tables.concepts.find((c) => c.lesson_id === L2 && c.id === "y")!.retired = true;
    const fractions = (await loadLearnerHome(db.asUser(ME))).find((p) => p.lessonId === L2)!;
    expect(fractions).toMatchObject({ totalConcepts: 1, masteredConcepts: 1, status: "complete" });
  });

  it("copes with a lesson that has no ideas", async () => {
    db.tables.lessons.push({
      id: L1,
      title: "Empty",
      status: "published",
      owner_id: OWNER,
      created_at: "x",
    });
    assign(L1);
    const [only] = await loadLearnerHome(db.asUser(ME));
    expect(only).toMatchObject({ totalConcepts: 0, status: "not_started" });
    expect(progressFraction(only)).toBe(0);
  });

  it("returns nothing when there are no lessons", async () => {
    expect(await loadLearnerHome(db.asUser(ME))).toEqual([]);
  });

  it("says plainly when a read fails", async () => {
    seed();
    db.failures.add("assignments.select");
    await expect(loadLearnerHome(db.asUser(ME))).rejects.toMatchObject({
      status: 500,
      code: "read_failed",
    });
    db.failures.add("lessons.select");
    await expect(loadLearnerHome(db.asUser(ME))).rejects.toMatchObject({ status: 500 });
    db.failures.add("concepts.select");
    await expect(loadLearnerHome(db.asUser(ME))).rejects.toMatchObject({ status: 500 });
  });
});

describe("the learner home page", () => {
  it("sends a signed-out visitor to sign in", async () => {
    mocks.userId = null;
    await expect(LearnerHomePage()).rejects.toMatchObject({ to: "/sign-in?next=%2Flearn" });
  });

  it("shows each lesson as a link with a progress bar and the numbers in words", async () => {
    seed([
      [ME, L1, "a", "mastered"],
      [ME, L1, "b", "mastered"],
    ]);
    render(await LearnerHomePage());
    expect(screen.getByRole("heading", { level: 1, name: "My lessons" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "The Water Cycle" });
    expect(link).toHaveAttribute("href", `/learn/${L1}`);
    const card = link.closest("li")!;
    expect(within(card).getByText("2 of 5 ideas mastered")).toBeInTheDocument();
    expect(
      within(card).getByRole("progressbar", { name: "Progress in The Water Cycle" }),
    ).toHaveAttribute("value", "40");
    expect(within(card).getByText("In progress")).toBeInTheDocument();
  });

  it("groups the lessons under an Assigned heading and says when each is due", async () => {
    seed([], { [L1]: "2026-10-14T23:59:59.000Z", [L2]: "2020-01-01T23:59:59.000Z" });
    render(await LearnerHomePage());
    const section = screen.getByRole("region", { name: "Assigned" });
    expect(within(section).getAllByRole("heading", { level: 3 })).toHaveLength(2);
    expect(within(section).getByText(/Due 14 Oct 2026/)).toBeInTheDocument();
    expect(within(section).getByText(/Due 1 Jan 2020 · Overdue/)).toBeInTheDocument();
  });

  it("matches mastered over total for every lesson", async () => {
    seed([
      [ME, L1, "a", "mastered"],
      [ME, L2, "x", "mastered"],
      [ME, L2, "y", "mastered"],
    ]);
    render(await LearnerHomePage());
    expect(
      screen.getByRole("progressbar", { name: "Progress in The Water Cycle" }),
    ).toHaveAttribute("value", "20");
    expect(screen.getByRole("progressbar", { name: "Progress in Fractions" })).toHaveAttribute(
      "value",
      "100",
    );
    expect(screen.getByText("Complete")).toBeInTheDocument();
  });

  it("offers the sharing choice, off by default, below the lessons", async () => {
    seed();
    render(await LearnerHomePage());
    const box = screen.getByRole("checkbox", { name: "Share my settings with my teachers" });
    expect(box).not.toBeChecked();
  });
  it("explains an empty home kindly", async () => {
    render(await LearnerHomePage());
    expect(screen.getByText(/no lessons for you yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    seed([[ME, L1, "a", "mastered"]]);
    const { container } = render(await LearnerHomePage());
    await expectNoAxeViolations(container);
  });
});
