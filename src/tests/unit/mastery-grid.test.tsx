// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HardestIdeas } from "@/app/teach/classrooms/[id]/HardestIdeas";
import { MasteryGridTable } from "@/app/teach/classrooms/[id]/MasteryGridTable";
import {
  loadHardestIdeas,
  loadMasteryGrid,
  rankHardestIdeas,
  sortStudents,
  type GridStudent,
  type MasteryStatus,
} from "@/lib/classrooms/grid";
import { expectNoAxeViolations } from "../a11y";
import { callsOn, opsNamed, recordingClient } from "../fixtures/recording-supabase";

const CLASS = "22222222-2222-4222-8222-222222222222";
const LESSON = "11111111-1111-4111-8111-111111111111";

const concepts = [
  { id: "c1", title: "Evaporation" },
  { id: "c2", title: "Condensation" },
];

function student(
  id: string,
  name: string,
  statuses: [MasteryStatus, MasteryStatus],
  seconds = 0,
): GridStudent {
  return {
    studentId: id,
    name,
    cells: {
      c1: { status: statuses[0], attempts: 0 },
      c2: { status: statuses[1], attempts: 0 },
    },
    mastered: statuses.filter((s) => s === "mastered").length,
    total: 2,
    answered: 0,
    correct: 0,
    activeSeconds: seconds,
  };
}

const roster = [
  student("s1", "Maya", ["mastered", "mastered"], 125),
  student("s2", "Tunde", ["mastered", "in_progress"], 60),
  student("s3", "Sofia", ["not_started", "not_started"]),
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sortStudents", () => {
  const names = (list: GridStudent[]) => list.map((s) => s.name);

  it("sorts by name in either direction", () => {
    expect(names(sortStudents(roster, "name", "ascending"))).toEqual(["Maya", "Sofia", "Tunde"]);
    expect(names(sortStudents(roster, "name", "descending"))).toEqual(["Tunde", "Sofia", "Maya"]);
  });

  it("sorts by ideas mastered, breaking ties by name", () => {
    const tied = [...roster, student("s4", "Ana", ["mastered", "not_started"])];
    expect(names(sortStudents(tied, "mastered", "descending"))).toEqual([
      "Maya",
      "Ana",
      "Tunde",
      "Sofia",
    ]);
    expect(names(sortStudents(tied, "mastered", "ascending"))).toEqual([
      "Sofia",
      "Ana",
      "Tunde",
      "Maya",
    ]);
  });

  it("sorts by how far each got on one idea: mastered, then in progress, then not started", () => {
    expect(names(sortStudents(roster, "concept:c2", "descending"))).toEqual([
      "Maya",
      "Tunde",
      "Sofia",
    ]);
  });

  it("does not change the list it is given", () => {
    const copy = [...roster];
    sortStudents(roster, "mastered", "descending");
    expect(roster).toEqual(copy);
  });
});

describe("loadMasteryGrid", () => {
  const cell = (
    student_id: string,
    display_name: string | null,
    concept_id: string,
    order_index: number,
    status: string,
  ) => ({
    student_id,
    display_name,
    concept_id,
    concept_title: concept_id === "c1" ? "Evaporation" : "Condensation",
    order_index,
    status,
    attempts: status === "not_started" ? 0 : 2,
  });

  const progress = [
    {
      student_id: "s1",
      mastered_concepts: 1,
      total_concepts: 2,
      answered: 4,
      correct: 3,
      active_seconds: 90,
    },
  ];

  it("builds columns in lesson order and a cell for each student and idea", async () => {
    const { client, calls } = recordingClient({
      tables: {
        v_classroom_concept_mastery: {
          data: [
            cell("s1", "Maya", "c2", 1, "in_progress"),
            cell("s1", "Maya", "c1", 0, "mastered"),
            cell("s2", "Ana", "c1", 0, "not_started"),
            cell("s2", "Ana", "c2", 1, "not_started"),
          ],
        },
        v_classroom_student_progress: { data: progress },
      },
    });
    const grid = await loadMasteryGrid(client, CLASS, LESSON);
    expect(grid.concepts.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(grid.students.map((s) => s.name)).toEqual(["Ana", "Maya"]);
    const maya = grid.students.find((s) => s.name === "Maya")!;
    expect(maya.cells.c1.status).toBe("mastered");
    expect(maya).toMatchObject({
      mastered: 1,
      total: 2,
      answered: 4,
      correct: 3,
      activeSeconds: 90,
    });
    expect(opsNamed(callsOn(calls, "v_classroom_concept_mastery")[0], "eq")).toEqual([
      ["classroom_id", CLASS],
      ["lesson_id", LESSON],
    ]);
  });

  it("shows a student with no name by position, never by id", async () => {
    const { client } = recordingClient({
      tables: {
        v_classroom_concept_mastery: { data: [cell("s9", " ", "c1", 0, "not_started")] },
        v_classroom_student_progress: { data: [] },
      },
    });
    const grid = await loadMasteryGrid(client, CLASS, LESSON);
    expect(grid.students[0].name).toBe("Student 1");
  });

  it("treats an unknown status as not started", async () => {
    const { client } = recordingClient({
      tables: {
        v_classroom_concept_mastery: { data: [cell("s1", "Maya", "c1", 0, "weird")] },
        v_classroom_student_progress: { data: [] },
      },
    });
    expect((await loadMasteryGrid(client, CLASS, LESSON)).students[0].cells.c1.status).toBe(
      "not_started",
    );
  });

  it("says plainly when a view cannot be read", async () => {
    const { client } = recordingClient({
      tables: {
        v_classroom_concept_mastery: { error: { message: "secret detail" } },
        v_classroom_student_progress: { data: [] },
      },
    });
    const error = await loadMasteryGrid(client, CLASS, LESSON).catch((e) => e);
    expect(error).toMatchObject({ status: 500, code: "read_failed" });
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("MasteryGridTable", () => {
  const renderGrid = () =>
    render(
      <MasteryGridTable
        classroomId={CLASS}
        lessonTitle="The Water Cycle"
        concepts={concepts}
        students={roster}
      />,
    );

  it("has no accessibility violations", async () => {
    const { container } = renderGrid();
    await expectNoAxeViolations(container);
  });

  it("is a table that screen reader table commands can use: a caption, column headers and row headers", () => {
    renderGrid();
    const table = screen.getByRole("table", { name: /Mastery of each idea in The Water Cycle/ });
    const columns = within(table).getAllByRole("columnheader");
    expect(columns.map((c) => c.textContent?.replace(/[▲▼]/g, "").trim())).toEqual([
      "Student",
      "Evaporation",
      "Condensation",
      "Mastered",
      "Time spent",
    ]);
    const rowHeaders = within(table).getAllByRole("rowheader");
    expect(rowHeaders.map((r) => r.textContent)).toEqual(["Maya", "Sofia", "Tunde"]);
    for (const th of within(table).getAllByRole("columnheader")) {
      expect(th.getAttribute("scope")).toBe("col");
    }
    for (const th of rowHeaders) expect(th.getAttribute("scope")).toBe("row");
    // Every body row has a cell for every column after the row header.
    for (const row of within(table).getAllByRole("row").slice(1)) {
      expect(within(row).getAllByRole("cell")).toHaveLength(4);
    }
  });

  it("says each state in words, with a mark that is hidden from screen readers", () => {
    renderGrid();
    const maya = screen.getByRole("row", { name: /Maya/ });
    expect(within(maya).getAllByText("Mastered")).toHaveLength(2);
    const tunde = screen.getByRole("row", { name: /Tunde/ });
    expect(within(tunde).getByText("In progress")).toBeTruthy();
    const sofia = screen.getByRole("row", { name: /Sofia/ });
    expect(within(sofia).getAllByText("Not started")).toHaveLength(2);
    expect(maya.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it("shows the totals and time spent", () => {
    renderGrid();
    const maya = screen.getByRole("row", { name: /Maya/ });
    expect(within(maya).getByText("2 of 2")).toBeTruthy();
    expect(within(maya).getByText(/2 min/)).toBeTruthy();
  });

  it("starts sorted by name and says so", () => {
    renderGrid();
    expect(screen.getByRole("columnheader", { name: /Student/ }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /Mastered/ }).getAttribute("aria-sort")).toBe(
      "none",
    );
  });

  it("sorts by ideas mastered, furthest first, then reverses", async () => {
    renderGrid();
    const order = () => screen.getAllByRole("rowheader").map((r) => r.textContent);
    await userEvent.click(screen.getByRole("button", { name: /Mastered/ }));
    expect(order()).toEqual(["Maya", "Tunde", "Sofia"]);
    expect(screen.getByRole("columnheader", { name: /Mastered/ }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    await userEvent.click(screen.getByRole("button", { name: /Mastered/ }));
    expect(order()).toEqual(["Sofia", "Tunde", "Maya"]);
    expect(screen.getByRole("columnheader", { name: /Mastered/ }).getAttribute("aria-sort")).toBe(
      "ascending",
    );
  });

  it("sorts by one idea's column", async () => {
    renderGrid();
    await userEvent.click(screen.getByRole("button", { name: /Condensation/ }));
    expect(screen.getAllByRole("rowheader").map((r) => r.textContent)).toEqual([
      "Maya",
      "Tunde",
      "Sofia",
    ]);
    expect(screen.getByRole("table").querySelector("caption")?.textContent).toMatch(
      /Sorted by Condensation, descending/,
    );
  });

  it("can be reached and scrolled by keyboard", () => {
    renderGrid();
    const region = screen.getByRole("region", { name: "The Water Cycle: mastery by student" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });
});

describe("hardest ideas", () => {
  const idea = (conceptId: string, title: string, errorRate: number, attempts: number) => ({
    conceptId,
    title,
    attempts,
    correct: Math.round(attempts * (1 - errorRate)),
    errorRate,
  });

  it("ranks by wrong-answer share, then by how many answers are behind it, then by title", () => {
    const ranked = rankHardestIdeas([
      idea("a", "Alpha", 0.2, 10),
      idea("b", "Bravo", 0.6, 5),
      idea("c", "Charlie", 0.6, 20),
      idea("d", "Delta", 0.6, 20),
    ]);
    expect(ranked.map((i) => i.title)).toEqual(["Charlie", "Delta", "Bravo", "Alpha"]);
  });

  it("loads the view rows, leaves out ideas nobody answered, and reads numeric strings", async () => {
    const { client, calls } = recordingClient({
      tables: {
        v_classroom_concept_difficulty: {
          data: [
            { concept_id: "c1", concept_title: "Easy", attempts: 10, correct: 9, error_rate: 0.1 },
            {
              concept_id: "c2",
              concept_title: "Hard",
              attempts: 8,
              correct: 2,
              error_rate: "0.750",
            },
            {
              concept_id: "c3",
              concept_title: "Untouched",
              attempts: 0,
              correct: 0,
              error_rate: null,
            },
          ],
        },
      },
    });
    const ideas = await loadHardestIdeas(client, CLASS, LESSON);
    expect(ideas.map((i) => [i.title, i.errorRate])).toEqual([
      ["Hard", 0.75],
      ["Easy", 0.1],
    ]);
    expect(opsNamed(callsOn(calls, "v_classroom_concept_difficulty")[0], "eq")).toEqual([
      ["classroom_id", CLASS],
      ["lesson_id", LESSON],
    ]);
  });

  it("says plainly when the view cannot be read", async () => {
    const { client } = recordingClient({
      tables: { v_classroom_concept_difficulty: { error: { message: "secret" } } },
    });
    await expect(loadHardestIdeas(client, CLASS, LESSON)).rejects.toMatchObject({ status: 500 });
  });

  it("lists the hardest first with a link to each idea in the lesson review", async () => {
    const ideas = [idea("c2", "Condensation", 0.75, 8), idea("c1", "Evaporation", 0.1, 10)];
    const { container } = render(<HardestIdeas lessonId={LESSON} ideas={ideas} />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByRole("link", { name: "Condensation" }).getAttribute("href")).toBe(
      `/teach/lessons/${LESSON}/review#concept-c2-heading`,
    );
    expect(within(rows[0]).getByText("75%")).toBeTruthy();
    expect(within(rows[0]).getByText("2 right of 8")).toBeTruthy();
    expect(within(rows[1]).getByRole("link", { name: "Evaporation" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("explains an empty list instead of showing an empty table", () => {
    render(<HardestIdeas lessonId={LESSON} ideas={[]} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/nothing to rank/)).toBeTruthy();
  });
});
