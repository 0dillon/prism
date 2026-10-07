// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BarChart } from "@/app/admin/BarChart";
import { ClassroomTable } from "@/app/admin/ClassroomTable";
import { Filters } from "@/app/admin/Filters";
import { LayoutPanel } from "@/app/admin/LayoutPanel";
import {
  describeEngagement,
  describeProgress,
  engagementPoints,
  progressPoints,
  weekLabel,
} from "@/lib/admin/charts";
import { CSV_COLUMNS, classroomsToCsv, csvCell } from "@/lib/admin/csv";
import {
  MIN_GROUP_SIZE,
  applyFilters,
  layoutShares,
  loadDashboard,
  type ClassroomRow,
} from "@/lib/admin/dashboard";
import {
  currentFilters,
  defaultRange,
  filtersToQuery,
  isCalendarDate,
  parseFilters,
  rangeLabel,
} from "@/lib/admin/filters";
import { expectNoAxeViolations } from "../a11y";
import { callsOn, opsNamed, recordingClient } from "../fixtures/recording-supabase";

const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  client: null as unknown,
  admin: null as unknown,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`redirect:${to}`), { to });
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        mocks.userId ? { data: { user: { id: mocks.userId } } } : { data: { user: null } },
    },
    ...(mocks.client as object),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));

import AdminPage from "@/app/admin/page";

const ORG = "11111111-1111-4111-8111-111111111111";
const T1 = "22222222-2222-4222-8222-222222222222";
const T2 = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-31T12:00:00Z");

const row = (over: Partial<ClassroomRow> = {}): ClassroomRow => ({
  classroomId: "c1",
  name: "Year 5 A",
  teacherId: T1,
  teacherName: "Ms Reyes",
  grade: "5",
  subject: "Science",
  students: 24,
  assignedLessons: 2,
  completion: 0.4167,
  averageMastery: 0.625,
  activeLearners: 20,
  activeSeconds: 7500,
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.userId = null;
  mocks.client = null;
  mocks.admin = null;
});
afterEach(() => vi.restoreAllMocks());

describe("filters", () => {
  it("default to the last 30 days with nothing else chosen", () => {
    const filters = parseFilters({}, NOW);
    expect(filters).toEqual({
      grade: null,
      subject: null,
      teacherId: null,
      from: "2026-10-02",
      to: "2026-10-31",
    });
    expect(defaultRange(NOW)).toEqual({ from: "2026-10-02", to: "2026-10-31" });
  });

  it("read grade, subject, teacher and dates from the URL", () => {
    const filters = parseFilters(
      { grade: "5", subject: "Science", teacher: T1, from: "2026-09-01", to: "2026-09-30" },
      NOW,
    );
    expect(filters).toEqual({
      grade: "5",
      subject: "Science",
      teacherId: T1,
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("ignore anything that is not valid instead of failing", () => {
    const filters = parseFilters(
      { grade: "x".repeat(99), teacher: "not-a-uuid", from: "2026-02-31", to: "2026-10-31" },
      NOW,
    );
    expect(filters.grade).toBeNull();
    expect(filters.teacherId).toBeNull();
    expect(filters.from).toBe("2026-10-02");
  });

  it("fall back to the default for a backwards range or one over a year", () => {
    expect(parseFilters({ from: "2026-10-31", to: "2026-10-01" }, NOW).from).toBe("2026-10-02");
    expect(parseFilters({ from: "2024-01-01", to: "2026-10-31" }, NOW).from).toBe("2026-10-02");
  });

  it("take the first value when a parameter is repeated, and treat blank as not chosen", () => {
    expect(parseFilters({ grade: ["6", "7"] }, NOW).grade).toBe("6");
    expect(parseFilters({ grade: "  ", subject: "" }, NOW)).toMatchObject({
      grade: null,
      subject: null,
    });
  });

  it("go back into the URL, leaving out the defaults, and read back the same", () => {
    expect(filtersToQuery(parseFilters({}, NOW), NOW).toString()).toBe("");
    const chosen = parseFilters(
      { grade: "5", teacher: T2, from: "2026-09-01", to: "2026-09-30" },
      NOW,
    );
    const query = filtersToQuery(chosen, NOW);
    expect(Object.fromEntries(query)).toEqual({
      grade: "5",
      teacher: T2,
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(parseFilters(Object.fromEntries(query), NOW)).toEqual(chosen);
  });

  it("recognise real calendar dates only", () => {
    expect(isCalendarDate("2026-10-31")).toBe(true);
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("31/10/2026")).toBe(false);
  });

  it("say the range in words", () => {
    expect(rangeLabel(parseFilters({ from: "2026-09-01", to: "2026-09-30" }, NOW))).toBe(
      "1 Sep 2026 to 30 Sep 2026",
    );
  });

  it("report whether any filter is active, using the clock", () => {
    expect(currentFilters({}).active).toBe(false);
    expect(currentFilters({ grade: "5" })).toMatchObject({ active: true, query: "grade=5" });
  });
});

describe("applyFilters", () => {
  const rows = [
    row({ classroomId: "a", grade: "5", subject: "Science", teacherId: T1 }),
    row({ classroomId: "b", grade: "6", subject: "Science", teacherId: T1 }),
    row({ classroomId: "c", grade: "5", subject: "Art", teacherId: T2 }),
  ];
  const f = (over: Record<string, string>) => parseFilters(over, NOW);

  it("changes the rows by grade, subject and teacher, and by all three together", () => {
    expect(applyFilters(rows, f({})).length).toBe(3);
    expect(applyFilters(rows, f({ grade: "5" })).map((r) => r.classroomId)).toEqual(["a", "c"]);
    expect(applyFilters(rows, f({ subject: "Art" })).map((r) => r.classroomId)).toEqual(["c"]);
    expect(applyFilters(rows, f({ teacher: T1 })).map((r) => r.classroomId)).toEqual(["a", "b"]);
    expect(
      applyFilters(rows, f({ grade: "5", subject: "Science", teacher: T1 })).map(
        (r) => r.classroomId,
      ),
    ).toEqual(["a"]);
  });
});

describe("layoutShares", () => {
  it("lists all four layouts in a fixed order, with a missing group shown as fewer than five", () => {
    const shares = layoutShares([
      { layout: "cards", learners: 8, share: "0.667" },
      { layout: "reader", learners: 4, share: "0.333" }, // too small, even if the database sent it
      { layout: "visual", learners: 4, share: 0.2 },
    ]);
    expect(shares).toEqual([
      { layout: "reader", learners: null, share: null },
      { layout: "cards", learners: 8, share: 0.667 },
      { layout: "conversation", learners: null, share: null },
      { layout: "visual", learners: null, share: null },
    ]);
  });

  it("never lets a group under the minimum through", () => {
    expect(MIN_GROUP_SIZE).toBe(5);
    expect(
      layoutShares([{ layout: "cards", learners: 4, share: 1 }]).every((l) => l.learners === null),
    ).toBe(true);
  });
});

describe("loadDashboard", () => {
  const filters = parseFilters({}, NOW);
  const summary = (over: Record<string, unknown> = {}) => ({
    org_id: ORG,
    classroom_id: "c1",
    classroom_name: "Year 5 A",
    teacher_id: T1,
    students: 24,
    assigned_lessons: 2,
    active_learners: 3,
    completion: "0.417",
    average_mastery: "0.625",
    ...over,
  });
  const world = (over: Record<string, unknown> = {}) =>
    recordingClient({
      tables: {
        organizations: { data: [{ name: "Oak School" }] },
        v_org_classroom_summary: {
          data: [
            summary(),
            summary({
              classroom_id: "c2",
              classroom_name: "Year 6 B",
              teacher_id: T2,
              students: 10,
            }),
          ],
        },
        classrooms: {
          data: [
            { id: "c1", grade: "5", subject: "Science" },
            { id: "c2", grade: "6", subject: null },
          ],
        },
        users_public: {
          data: [
            { id: T1, display_name: "Ms Reyes" },
            { id: T2, display_name: " " },
          ],
        },
        v_org_layout_usage: { data: [{ layout: "cards", learners: 9, share: 1 }] },
        ...over,
      },
      rpc: {
        org_classroom_activity: {
          data: [
            { classroom_id: "c1", active_learners: 20, active_seconds: 7500 },
            { classroom_id: "c2", active_learners: 0, active_seconds: 0 },
          ],
        },
        org_weekly_activity: {
          data: [
            {
              week_start: "2026-10-05",
              active_learners: 20,
              active_seconds: 7500,
              mastered_ideas: 12,
            },
          ],
        },
      },
    });

  it("builds a row per class from the summary view, using activity for the chosen dates", async () => {
    const { client, rpcCalls } = world();
    const dashboard = await loadDashboard(client, ORG, filters);
    expect(dashboard.orgName).toBe("Oak School");
    expect(dashboard.rows[0]).toEqual({
      classroomId: "c1",
      name: "Year 5 A",
      teacherId: T1,
      teacherName: "Ms Reyes",
      grade: "5",
      subject: "Science",
      students: 24,
      assignedLessons: 2,
      completion: 0.417,
      averageMastery: 0.625,
      activeLearners: 20,
      activeSeconds: 7500,
    });
    expect(rpcCalls.map((c) => c.args)).toEqual([
      { p_org: ORG, p_from: filters.from, p_to: filters.to },
      { p_org: ORG, p_from: filters.from, p_to: filters.to },
    ]);
  });

  it("names a teacher with no name by position, never by id", async () => {
    const dashboard = await loadDashboard(world().client, ORG, filters);
    expect(dashboard.rows[1].teacherName).toBe("Teacher 1");
    expect(JSON.stringify(dashboard)).not.toContain(`"teacherName":"${T2}"`);
  });

  it("offers filter choices from every class, then applies the filters to the rows", async () => {
    const dashboard = await loadDashboard(world().client, ORG, parseFilters({ grade: "6" }, NOW));
    expect(dashboard.options.grades).toEqual(["5", "6"]);
    expect(dashboard.options.subjects).toEqual(["Science"]);
    expect(dashboard.options.teachers.map((t) => t.id).sort()).toEqual([T1, T2].sort());
    expect(dashboard.rows.map((r) => r.name)).toEqual(["Year 6 B"]);
  });

  it("returns the weekly series and the layout shares, with small groups left as fewer than five", async () => {
    const dashboard = await loadDashboard(world().client, ORG, filters);
    expect(dashboard.weekly).toEqual([
      { weekStart: "2026-10-05", activeLearners: 20, activeSeconds: 7500, masteredIdeas: 12 },
    ]);
    expect(dashboard.layouts.find((l) => l.layout === "cards")).toMatchObject({ learners: 9 });
    expect(dashboard.layouts.filter((l) => l.learners === null)).toHaveLength(3);
  });

  it("asks the views only for this organization", async () => {
    const { client, calls } = world();
    await loadDashboard(client, ORG, filters);
    for (const table of ["v_org_classroom_summary", "v_org_layout_usage"]) {
      expect(opsNamed(callsOn(calls, table)[0], "eq")).toEqual([["org_id", ORG]]);
    }
  });

  it("does not select layout or profile data for any individual", async () => {
    const { client, calls } = world();
    await loadDashboard(client, ORG, filters);
    const tables = calls.map((c) => c.table);
    expect(tables).not.toContain("render_profiles");
    expect(tables).not.toContain("learning_events");
  });

  it("says the school is not found for someone who is not its principal", async () => {
    const { client } = recordingClient({
      tables: { organizations: { data: [{ name: "Oak" }] } },
      rpc: {
        org_classroom_activity: { error: { code: "42501", message: "x" } },
        org_weekly_activity: { error: { code: "42501", message: "x" } },
      },
    });
    await expect(loadDashboard(client, ORG, filters)).rejects.toMatchObject({ status: 404 });
  });

  it("says plainly when a read fails, without the database message", async () => {
    const error = await loadDashboard(
      world({ v_org_classroom_summary: { error: { message: "secret" } } }).client,
      ORG,
      filters,
    ).catch((e) => e);
    expect(error).toMatchObject({ status: 500, code: "read_failed" });
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("CSV", () => {
  it("has a header and a row per class, with CRLF line endings", () => {
    const csv = classroomsToCsv([row()]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_COLUMNS.join(","));
    expect(lines[1]).toBe("Year 5 A,Ms Reyes,5,Science,24,2,42,63,20,125");
    expect(lines.at(-1)).toBe("");
  });

  it("has no layout or profile column", () => {
    expect(CSV_COLUMNS.join(" ")).not.toMatch(/layout|profile|view/i);
  });

  it("quotes cells with commas, quotes and line breaks", () => {
    expect(csvCell('Year 5, "A"')).toBe('"Year 5, ""A"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(null)).toBe("");
  });

  it("makes a cell that a spreadsheet would run as a formula plain text", () => {
    expect(csvCell('=HYPERLINK("http://evil.test")')).toBe('"\'=HYPERLINK(""http://evil.test"")"');
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    // A real number is never changed, even a negative one.
    expect(csvCell(-3)).toBe("-3");
  });

  it("leaves completion and mastery blank when nothing is assigned, as the table shows a dash", () => {
    const csv = classroomsToCsv([row({ assignedLessons: 0 })]);
    expect(csv.split("\r\n")[1]).toBe("Year 5 A,Ms Reyes,5,Science,24,0,,,20,125");
  });

  it("matches the on-screen table cell for cell", () => {
    const rows = [
      row(),
      row({
        classroomId: "c2",
        name: "Year 6 B",
        grade: null,
        subject: null,
        assignedLessons: 0,
        activeSeconds: 20,
      }),
    ];
    render(<ClassroomTable rows={rows} rangeLabel="1 Oct 2026 to 31 Oct 2026" />);
    const table = screen.getByRole("table");
    const onScreen = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((tr) => [...tr.querySelectorAll("th, td")].map((c) => c.textContent));
    const csv = classroomsToCsv(rows)
      .trim()
      .split("\r\n")
      .slice(1)
      .map((line) => line.split(","));
    // Class, teacher, grade, subject and students are the same text; rates and activity are
    // the same numbers written two ways (42% and 42, 2 hours 5 minutes and 125 minutes).
    for (const [i, line] of csv.entries()) {
      expect(onScreen[i].slice(0, 5)).toEqual([
        line[0],
        line[1],
        line[2] || "–",
        line[3] || "–",
        line[4],
      ]);
      expect(onScreen[i][5]).toBe(line[6] === "" ? "–" : `${line[6]}%`);
      expect(onScreen[i][6]).toBe(line[7] === "" ? "–" : `${line[7]}%`);
      expect(onScreen[i][7]).toBe(`${line[8]} of ${line[4]}`);
    }
    expect(onScreen[0][8]).toBe("2 hours 5 minutes");
    expect(csv[0][9]).toBe("125");
    expect(onScreen[1][8]).toBe("Less than a minute");
    expect(csv[1][9]).toBe("0");
  });
});

describe("charts", () => {
  const weekly = [
    { weekStart: "2026-10-05", activeLearners: 10, activeSeconds: 3600, masteredIdeas: 4 },
    { weekStart: "2026-10-12", activeLearners: 30, activeSeconds: 7200, masteredIdeas: 9 },
    { weekStart: "2026-10-19", activeLearners: 20, activeSeconds: 5400, masteredIdeas: 0 },
  ];

  it("label a week by its first day", () => {
    expect(weekLabel("2026-10-05")).toBe("5 Oct");
    expect(weekLabel("2026-01-12")).toBe("12 Jan");
  });

  it("turn the series into points with the number in words", () => {
    expect(engagementPoints(weekly)[1]).toEqual({
      label: "12 Oct",
      value: 30,
      text: "30 learners, 2 hours",
    });
    expect(progressPoints(weekly)[0]).toEqual({ label: "5 Oct", value: 4, text: "4 ideas" });
  });

  it("describe the engagement chart in a sentence with the high, the low and the average", () => {
    const text = describeEngagement(engagementPoints(weekly));
    expect(text).toMatch(/over 3 weeks, from the week starting 5 Oct/);
    expect(text).toMatch(/most was 30 learners in the week starting 12 Oct/);
    expect(text).toMatch(/fewest was 10 in the week starting 5 Oct/);
    expect(text).toMatch(/average is 20 a week/);
  });

  it("describe the progress chart, and say so plainly when nothing happened", () => {
    expect(describeProgress(progressPoints(weekly))).toMatch(/Ideas mastered over 3 weeks/);
    const quiet = weekly.map((w) => ({ ...w, masteredIdeas: 0 }));
    expect(describeProgress(progressPoints(quiet))).toBe("No ideas mastered in these 3 weeks.");
    expect(describeProgress([])).toBe("No weeks to show for ideas mastered.");
  });

  it("describe a flat series without inventing a high and a low", () => {
    const flat = weekly.map((w) => ({ ...w, activeLearners: 7 }));
    expect(describeEngagement(engagementPoints(flat))).toMatch(/It was 7 learners every week/);
  });

  it("give every chart a sentence, a labelled value on every bar and a table of the same numbers", async () => {
    const points = engagementPoints(weekly);
    const { container } = render(
      <BarChart
        title="Learners active each week"
        valueHeading="Learners and time"
        summary={describeEngagement(points)}
        points={points}
      />,
    );
    expect(screen.getByText(/over 3 weeks/)).toBeTruthy();
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect([...svg.querySelectorAll("text")].map((t) => t.textContent)).toEqual([
      "10",
      "5 Oct",
      "30",
      "12 Oct",
      "20",
      "19 Oct",
    ]);
    const table = screen.getByRole("table", { hidden: true });
    const cells = within(table).getAllByRole("row", { hidden: true }).slice(1);
    expect(cells).toHaveLength(3);
    expect(container.querySelector("details summary")?.textContent).toBe("View as a table");
    await expectNoAxeViolations(container);
  });
});

describe("LayoutPanel", () => {
  it("shows a group of 4 as fewer than 5, and never its count", async () => {
    const shares = layoutShares([
      { layout: "cards", learners: 12, share: 1 },
      { layout: "visual", learners: 4, share: 0.25 },
    ]);
    const { container } = render(<LayoutPanel layouts={shares} />);
    const visual = screen.getByRole("row", { name: /Pictures and signs/ });
    expect(visual.textContent).toContain("Fewer than 5 learners");
    expect(visual.textContent).not.toMatch(/\b4\b/);
    expect(screen.getByRole("row", { name: /Cards/ }).textContent).toContain("12 learners");
    expect(screen.getByRole("row", { name: /Cards/ }).textContent).toContain("100%");
    expect(screen.getByText(/never shown/)).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("explains an empty panel instead of showing a table of dashes", () => {
    render(<LayoutPanel layouts={layoutShares([])} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/not enough learners yet/)).toBeTruthy();
  });

  it("is only ever organization-wide", () => {
    render(<LayoutPanel layouts={layoutShares([{ layout: "cards", learners: 9, share: 1 }])} />);
    expect(screen.getByText(/never broken down by class or person/)).toBeTruthy();
  });
});

describe("Filters", () => {
  const options = {
    grades: ["5", "6"],
    subjects: ["Science"],
    teachers: [{ id: T1, name: "Ms Reyes" }],
  };

  it("is a plain GET form, so the choices are in the URL", () => {
    render(
      <Filters
        options={options}
        filters={parseFilters({}, NOW)}
        orgId={ORG}
        multipleOrgs={false}
        active={false}
      />,
    );
    const form = screen.getByRole("form", { name: "Filter classes" });
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/admin");
  });

  it("shows the current choices and offers a way to clear them", async () => {
    const filters = parseFilters(
      { grade: "6", teacher: T1, from: "2026-09-01", to: "2026-09-30" },
      NOW,
    );
    const { container } = render(
      <Filters options={options} filters={filters} orgId={ORG} multipleOrgs active />,
    );
    expect((screen.getByLabelText("Grade") as HTMLSelectElement).value).toBe("6");
    expect((screen.getByLabelText("Teacher") as HTMLSelectElement).value).toBe(T1);
    expect((screen.getByLabelText("Activity from") as HTMLInputElement).value).toBe("2026-09-01");
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe(
      `/admin?org=${ORG}`,
    );
    expect(container.querySelector('input[name="org"]')?.getAttribute("value")).toBe(ORG);
    await expectNoAxeViolations(container);
  });

  it("does not offer to clear when nothing is filtered", () => {
    render(
      <Filters
        options={options}
        filters={parseFilters({}, NOW)}
        orgId={ORG}
        multipleOrgs={false}
        active={false}
      />,
    );
    expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
  });
});

describe("ClassroomTable", () => {
  it("is a table with a caption, column headers and a row header for each class", async () => {
    const { container } = render(
      <ClassroomTable rows={[row()]} rangeLabel="1 Oct 2026 to 31 Oct 2026" />,
    );
    const table = screen.getByRole("table", { name: /Each class with its teacher/ });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(9);
    expect(within(table).getByRole("rowheader", { name: "Year 5 A" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("says the totals in a sentence", () => {
    render(
      <ClassroomTable
        rows={[row(), row({ classroomId: "c2", students: 6, activeLearners: 1 })]}
        rangeLabel="x"
      />,
    );
    expect(screen.getByText(/2 classes shown, with 30 students/)).toBeTruthy();
    expect(screen.getByText(/21 students were active/)).toBeTruthy();
  });

  it("explains an empty result", () => {
    render(<ClassroomTable rows={[]} rangeLabel="x" />);
    expect(screen.getByText(/No classes match/)).toBeTruthy();
  });
});

describe("the principal page", () => {
  const tables = () => ({
    org_memberships: { data: [{ org_id: ORG }] },
    organizations: { data: [{ id: ORG, name: "Oak School" }] },
    v_org_classroom_summary: {
      data: [
        {
          org_id: ORG,
          classroom_id: "c1",
          classroom_name: "Year 5 A",
          teacher_id: T1,
          students: 24,
          assigned_lessons: 1,
          completion: 0.4,
          average_mastery: 0.5,
        },
      ],
    },
    classrooms: { data: [{ id: "c1", grade: "5", subject: "Science" }] },
    users_public: { data: [{ id: T1, display_name: "Ms Reyes" }] },
    v_org_layout_usage: { data: [] },
  });
  const rpc = {
    org_classroom_activity: {
      data: [{ classroom_id: "c1", active_learners: 12, active_seconds: 3000 }],
    },
    org_weekly_activity: {
      data: [
        { week_start: "2026-10-05", active_learners: 12, active_seconds: 3000, mastered_ideas: 7 },
      ],
    },
  };

  it("sends a signed-out visitor to sign in, and a user with no school to set one up", async () => {
    await expect(AdminPage({ searchParams: Promise.resolve({}) } as never)).rejects.toMatchObject({
      to: "/sign-in?next=%2Fadmin",
    });
    mocks.userId = T1;
    mocks.client = recordingClient({ tables: { org_memberships: { data: [] } } }).client;
    await expect(AdminPage({ searchParams: Promise.resolve({}) } as never)).rejects.toMatchObject({
      to: "/admin/setup",
    });
  });

  it("shows the classes, both charts with their tables, the layout panel and the CSV link", async () => {
    mocks.userId = T1;
    mocks.client = recordingClient({ tables: tables(), rpc }).client;
    const { container } = render(await AdminPage({ searchParams: Promise.resolve({}) } as never));
    expect(screen.getByRole("heading", { level: 1, name: "Oak School" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Year 5 A" })).toBeTruthy();
    expect(screen.getAllByRole("figure")).toHaveLength(2);
    expect(container.querySelectorAll("figure details table")).toHaveLength(2);
    expect(screen.getByText(/not enough learners yet/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /Download these classes as a CSV file/ });
    expect(link.getAttribute("href")).toBe(`/api/orgs/${ORG}/export`);
    await expectNoAxeViolations(container);
  });

  it("carries the filters into the CSV link and applies them to the table", async () => {
    mocks.userId = T1;
    mocks.client = recordingClient({ tables: tables(), rpc }).client;
    render(await AdminPage({ searchParams: Promise.resolve({ grade: "6" }) } as never));
    expect(screen.getByText(/No classes match/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Download these classes/ }).getAttribute("href")).toBe(
      `/api/orgs/${ORG}/export?grade=6`,
    );
    expect(screen.getByRole("link", { name: "Clear filters" })).toBeTruthy();
  });
});

describe("GET /api/orgs/[id]/export", () => {
  const get = async (query = "", id = ORG) => {
    const { GET } = await import("@/app/api/orgs/[id]/export/route");
    return GET(new NextRequest(`http://localhost/api/orgs/${id}/export${query}`), {
      params: Promise.resolve({ id }),
    } as never);
  };
  const dashboardTables = () => ({
    organizations: { data: [{ name: "Oak" }] },
    v_org_classroom_summary: {
      data: [
        {
          org_id: ORG,
          classroom_id: "c1",
          classroom_name: "=Year 5",
          teacher_id: T1,
          students: 3,
          assigned_lessons: 1,
          completion: 0.5,
          average_mastery: 0.5,
        },
      ],
    },
    classrooms: { data: [{ id: "c1", grade: "5", subject: "Art" }] },
    users_public: { data: [{ id: T1, display_name: "Ms Reyes" }] },
    v_org_layout_usage: { data: [] },
  });
  const rpc = {
    org_classroom_activity: {
      data: [{ classroom_id: "c1", active_learners: 2, active_seconds: 600 }],
    },
    org_weekly_activity: { data: [] },
  };

  it("needs a signed-in user", async () => {
    expect((await get()).status).toBe(401);
  });

  it("returns the table as a CSV attachment, with formulas made safe, and records the download", async () => {
    mocks.userId = T1;
    mocks.client = recordingClient({ tables: dashboardTables(), rpc }).client;
    const admin = recordingClient({ tables: { audit_log: { data: [] } } });
    mocks.admin = admin.client;
    const response = await get("?from=2026-10-01&to=2026-10-31&grade=5");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="classes-2026-10-01-to-2026-10-31.csv"',
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.text();
    expect(body.split("\r\n")[1]).toBe("'=Year 5,Ms Reyes,5,Art,3,1,50,50,2,10");
    const insert = opsNamed(callsOn(admin.calls, "audit_log")[0], "insert")[0][0] as Record<
      string,
      unknown
    >;
    expect(insert).toMatchObject({ org_id: ORG, actor_id: T1, action: "export.classes" });
    expect(JSON.stringify(insert.metadata)).not.toMatch(/layout|profile/);
  });

  it("is not found for someone who is not the principal, and returns no data", async () => {
    mocks.userId = T1;
    mocks.client = recordingClient({
      tables: { organizations: { data: [{ name: "Oak" }] } },
      rpc: {
        org_classroom_activity: { error: { code: "42501", message: "x" } },
        org_weekly_activity: { error: { code: "42501", message: "x" } },
      },
    }).client;
    mocks.admin = recordingClient().client;
    const response = await get();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Class");
  });

  it("rejects an id that is not an id", async () => {
    mocks.userId = T1;
    expect((await get("", "nope")).status).toBe(404);
  });
});
