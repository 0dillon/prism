// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadLessonProgress, MAX_EVENT_ACTIVE_MS } from "@/lib/lessons/progress-service";
import { expectNoAxeViolations } from "../a11y";
import { FakeSupabase } from "../fixtures/fake-supabase";

const OWNER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "77777777-7777-4777-8777-777777777777";
const LESSON = "11111111-1111-4111-8111-111111111111";
const MAYA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TUNDE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOFIA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NAMELESS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mocks = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null }));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`redirect:${to}`), { kind: "redirect", to });
  },
  notFound: () => {
    throw Object.assign(new Error("notFound"), { kind: "notFound" });
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
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (mocks.db as FakeSupabase).asAdmin(),
}));

import ProgressPage from "@/app/teach/lessons/[id]/progress/page";

let db: FakeSupabase;

const CONCEPTS = ["a", "b", "c", "d"];
const mastery = (user: string, concept: string, status: string, attempts = 2, correct = 2) =>
  db.tables.concept_mastery.push({
    user_id: user,
    lesson_id: LESSON,
    concept_id: concept,
    status,
    attempts,
    correct_count: correct,
  });
const event = (user: string, ms: number, layout: string) =>
  db.tables.learning_events.push({ user_id: user, lesson_id: LESSON, duration_ms: ms, layout });

beforeEach(() => {
  db = new FakeSupabase();
  mocks.db = db;
  mocks.userId = OWNER;
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.tables.lessons.push({
    id: LESSON,
    title: "The Water Cycle",
    status: "published",
    owner_id: OWNER,
  });
  for (const id of CONCEPTS) db.tables.concepts.push({ lesson_id: LESSON, id, retired: false });
  db.tables.users_public.push(
    { id: MAYA, display_name: "Maya" },
    { id: TUNDE, display_name: "Tunde" },
    { id: SOFIA, display_name: "Sofia" },
    { id: NAMELESS, display_name: "  " },
  );
});

/** Three learners on three layouts, who finish, half-finish and barely start. */
function seedThreeLearners() {
  for (const c of CONCEPTS) mastery(MAYA, c, "mastered");
  event(MAYA, 120_000, "cards");
  mastery(TUNDE, "a", "mastered");
  mastery(TUNDE, "b", "mastered");
  mastery(TUNDE, "c", "in_progress", 1, 0);
  event(TUNDE, 45_000, "conversation");
  mastery(SOFIA, "a", "in_progress", 1, 1);
  event(SOFIA, 30_000, "visual");
}

describe("loadLessonProgress", () => {
  it("puts three learners on one scale: ideas mastered over ideas in the lesson", async () => {
    seedThreeLearners();
    const report = await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON);
    expect(report.totalConcepts).toBe(4);
    expect(report.learners.map((l) => [l.name, l.masteredConcepts, l.totalConcepts])).toEqual([
      ["Maya", 4, 4],
      ["Sofia", 0, 4],
      ["Tunde", 2, 4],
    ]);
  });

  it("counts questions and active time for each learner", async () => {
    seedThreeLearners();
    const report = await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON);
    const tunde = report.learners.find((l) => l.name === "Tunde")!;
    expect(tunde).toMatchObject({ answered: 5, correct: 4, activeSeconds: 45 });
  });

  it("caps each event's time, so an idle tab does not count as study", async () => {
    mastery(MAYA, "a", "mastered");
    event(MAYA, 3_600_000, "cards");
    event(MAYA, 10_000, "cards");
    const [maya] = (await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON))
      .learners;
    expect(maya.activeSeconds).toBe((MAX_EVENT_ACTIVE_MS + 10_000) / 1000);
  });

  it("never reports the layout anyone used", async () => {
    seedThreeLearners();
    const report = await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON);
    expect(JSON.stringify(report)).not.toMatch(/cards|conversation|visual|reader|layout/i);
  });

  it("ignores mastery of ideas no longer in the lesson", async () => {
    mastery(MAYA, "a", "mastered");
    mastery(MAYA, "gone", "mastered");
    const [maya] = (await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON))
      .learners;
    expect(maya.masteredConcepts).toBe(1);
  });

  it("includes a learner who has only events, with no mastery yet", async () => {
    event(SOFIA, 5_000, "visual");
    const report = await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON);
    expect(report.learners).toEqual([
      expect.objectContaining({
        name: "Sofia",
        masteredConcepts: 0,
        answered: 0,
        activeSeconds: 5,
      }),
    ]);
  });

  it("numbers a learner with no name instead of showing an id", async () => {
    mastery(NAMELESS, "a", "mastered");
    mastery(MAYA, "a", "mastered");
    const report = await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON);
    expect(report.learners.map((l) => l.name)).toEqual(["Maya", "Learner 1"]);
    expect(JSON.stringify(report)).not.toContain(NAMELESS);
  });

  it("is empty for a lesson nobody has worked on", async () => {
    expect(
      (await loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON)).learners,
    ).toEqual([]);
  });

  it("is only for the lesson's owner: anyone else, and a missing lesson, get the same answer", async () => {
    seedThreeLearners();
    await expect(
      loadLessonProgress(db.asUser(STRANGER), db.asAdmin(), STRANGER, LESSON),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loadLessonProgress(
        db.asUser(OWNER),
        db.asAdmin(),
        OWNER,
        "99999999-9999-4999-8999-999999999999",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("says plainly when a read fails", async () => {
    db.failures.add("concept_mastery.select");
    await expect(
      loadLessonProgress(db.asUser(OWNER), db.asAdmin(), OWNER, LESSON),
    ).rejects.toMatchObject({
      status: 500,
      code: "read_failed",
    });
  });
});

describe("the progress page", () => {
  const open = (id = LESSON) => ProgressPage({ params: Promise.resolve({ id }) } as never);
  const kind = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return (error as { kind?: string }).kind ?? "other";
    }
    return "rendered";
  };

  it("shows each learner in a table on one common scale, with no layout", async () => {
    seedThreeLearners();
    const { container } = render(await open());
    expect(
      screen.getByRole("heading", { level: 1, name: "Progress: The Water Cycle" }),
    ).toBeInTheDocument();
    const table = screen.getByRole("table", {
      name: "Progress of each learner on The Water Cycle",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("rowheader")[0].textContent)).toEqual([
      "Maya",
      "Sofia",
      "Tunde",
    ]);
    expect(within(rows[0]).getByText("4 of 4 mastered")).toBeInTheDocument();
    expect(within(rows[2]).getByRole("progressbar", { name: "Tunde, progress" })).toHaveAttribute(
      "value",
      "50",
    );
    expect(within(rows[2]).getByText("4 of 5")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/cards|conversation|visual|reader/i);
  });

  it("says when no one has worked on the lesson", async () => {
    render(await open());
    expect(screen.getByText("No one has worked on this lesson yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("sends a signed-out visitor to sign in, and shows a stranger nothing", async () => {
    mocks.userId = null;
    expect(await kind(open())).toBe("redirect");
    mocks.userId = STRANGER;
    expect(await kind(open())).toBe("notFound");
    expect(await kind(open("not-a-uuid"))).toBe("notFound");
  });

  it("has no axe violations", async () => {
    seedThreeLearners();
    const { container } = render(await open());
    await expectNoAxeViolations(container);
  });
});
