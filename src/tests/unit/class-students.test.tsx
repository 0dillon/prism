// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddStudents } from "@/app/teach/classrooms/[id]/AddStudents";
import { JoinClassForm } from "@/app/learn/JoinClassForm";
import {
  MAX_STUDENTS_PER_ADD,
  addStudents,
  joinClassroom,
  loadRoster,
  parseCsvRows,
  parseEmailList,
  parseStudentCsv,
  regenerateJoinCode,
} from "@/lib/classrooms/students";
import { expectNoAxeViolations } from "../a11y";
import { recordingClient } from "../fixtures/recording-supabase";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  userId: null as string | null,
  client: null as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
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

const ROOM = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.refresh.mockReset();
  mocks.userId = null;
  mocks.client = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("parseEmailList", () => {
  it("splits on commas, semicolons, spaces and lines, and lowercases", () => {
    const { emails, rejected } = parseEmailList("A@x.test, b@x.test;C@x.test\n d@x.test  e@x.test");
    expect(emails).toEqual(["a@x.test", "b@x.test", "c@x.test", "d@x.test", "e@x.test"]);
    expect(rejected).toEqual([]);
  });

  it("reports what is not an address, with its line, and repeats once", () => {
    const { emails, rejected } = parseEmailList("a@x.test\nnot-an-email\nA@x.test");
    expect(emails).toEqual(["a@x.test"]);
    expect(rejected).toEqual([
      { line: 2, value: "not-an-email", reason: "This is not a valid email address." },
      { line: 3, value: "A@x.test", reason: "This address is listed more than once." },
    ]);
  });

  it("accepts addresses wrapped in angle brackets and ignores blank input", () => {
    expect(parseEmailList("<a@x.test>").emails).toEqual(["a@x.test"]);
    expect(parseEmailList("  \n ").emails).toEqual([]);
  });
});

describe("parseCsvRows", () => {
  it("reads quoted cells with commas, doubled quotes and line breaks", () => {
    const rows = parseCsvRows(
      'name,email\n"Lee, Ann","a@x.test"\n"Say ""hi""","b@x.test"\n"two\nlines",c@x.test',
    );
    expect(rows.map((r) => r.cells)).toEqual([
      ["name", "email"],
      ["Lee, Ann", "a@x.test"],
      ['Say "hi"', "b@x.test"],
      ["two\nlines", "c@x.test"],
    ]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 3, 4]);
  });

  it("handles Windows line endings, a byte order mark and blank rows", () => {
    const rows = parseCsvRows("﻿email\r\na@x.test\r\n\r\nb@x.test\r\n");
    expect(rows.map((r) => r.cells[0])).toEqual(["email", "a@x.test", "b@x.test"]);
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4]);
  });
});

describe("parseStudentCsv", () => {
  it("uses the column named email, in any position", () => {
    const { emails } = parseStudentCsv("Name,Email Address,Grade\nAnn,a@x.test,5\nBen,B@x.test,5");
    expect(emails).toEqual(["a@x.test", "b@x.test"]);
  });

  it("takes a single-column file with or without a header", () => {
    expect(parseStudentCsv("students\na@x.test").emails).toEqual(["a@x.test"]);
    expect(parseStudentCsv("a@x.test\nb@x.test").emails).toEqual(["a@x.test", "b@x.test"]);
  });

  it("reports a header with no email column instead of guessing", () => {
    const result = parseStudentCsv("name,grade\nAnn,5");
    expect(result.emails).toEqual([]);
    expect(result.rejected[0]).toMatchObject({
      line: 1,
      reason: "There is no column named email.",
    });
  });

  it("reports bad rows with their line numbers and keeps the good ones", () => {
    const { emails, rejected } = parseStudentCsv(
      "email\na@x.test\nbroken\n\n,x\nb@x.test\na@x.test",
    );
    expect(emails).toEqual(["a@x.test", "b@x.test"]);
    expect(rejected.map((r) => [r.line, r.reason])).toEqual([
      [3, "This is not a valid email address."],
      [5, "This row has no email address."],
      [7, "This address is listed more than once."],
    ]);
  });

  it("refuses an empty or oversized file", () => {
    expect(parseStudentCsv("").rejected[0].reason).toBe("The file has no rows.");
    const many =
      "email\n" +
      Array.from({ length: MAX_STUDENTS_PER_ADD + 1 }, (_, i) => `s${i}@x.test`).join("\n");
    expect(parseStudentCsv(many).rejected[0].reason).toMatch(/at most 500/);
  });
});

describe("addStudents", () => {
  const outcomes = (...list: Array<[string, string]>) => ({
    rpc: {
      add_students_by_email: {
        data: list.map(([student_email, outcome]) => ({ student_email, outcome })),
      },
    },
  });

  it("sends only the valid addresses and reports the rest", async () => {
    const { client, rpcCalls } = recordingClient(
      outcomes(["a@x.test", "added"], ["b@x.test", "already"]),
    );
    const report = await addStudents(client, ROOM, { emails: "a@x.test b@x.test nope" });
    expect(rpcCalls[0].args).toEqual({ p_classroom: ROOM, p_emails: ["a@x.test", "b@x.test"] });
    expect(report).toEqual({
      added: 1,
      already: 1,
      rejected: [{ line: 1, value: "nope", reason: "This is not a valid email address." }],
    });
  });

  it("reads a CSV the same way", async () => {
    const { client, rpcCalls } = recordingClient(outcomes(["a@x.test", "added"]));
    await addStudents(client, ROOM, { csv: "email\na@x.test" });
    expect(rpcCalls[0].args.p_emails).toEqual(["a@x.test"]);
  });

  it("does not call the database when nothing is usable", async () => {
    const { client, rpcCalls } = recordingClient();
    const report = await addStudents(client, ROOM, { emails: "nope" });
    expect(rpcCalls).toEqual([]);
    expect(report.added).toBe(0);
    expect(report.rejected).toHaveLength(1);
  });

  it("maps database refusals to clear errors", async () => {
    const refuse = (code: string) =>
      recordingClient({ rpc: { add_students_by_email: { error: { code, message: "x" } } } }).client;
    await expect(addStudents(refuse("42501"), ROOM, { emails: "a@x.test" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(addStudents(refuse("P0001"), ROOM, { emails: "a@x.test" })).rejects.toMatchObject({
      status: 409,
      code: "archived",
    });
    await expect(addStudents(refuse("XX000"), ROOM, { emails: "a@x.test" })).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("joinClassroom and regenerateJoinCode", () => {
  it("returns the class joined", async () => {
    const { client, rpcCalls } = recordingClient({ rpc: { join_classroom: { data: ROOM } } });
    expect(await joinClassroom(client, "abc123")).toEqual({ classroomId: ROOM });
    expect(rpcCalls[0].args).toEqual({ p_code: "abc123" });
  });

  it("says plainly when the code is wrong", async () => {
    const { client } = recordingClient({
      rpc: { join_classroom: { error: { code: "P0002", message: "x" } } },
    });
    const error = await joinClassroom(client, "nope").catch((e) => e);
    expect(error).toMatchObject({ status: 404, code: "code_not_found" });
    expect(error.message).toMatch(/Check it with your teacher/);
  });

  it("returns a new code, or not found for someone else's class", async () => {
    expect(
      await regenerateJoinCode(
        recordingClient({ rpc: { regenerate_join_code: { data: "NEW234" } } }).client,
        ROOM,
      ),
    ).toEqual({ joinCode: "NEW234" });
    const denied = recordingClient({
      rpc: { regenerate_join_code: { error: { code: "42501", message: "x" } } },
    });
    await expect(regenerateJoinCode(denied.client, ROOM)).rejects.toMatchObject({ status: 404 });
  });
});

describe("loadRoster", () => {
  it("lists students by name, falls back to a number, and counts waiting addresses", async () => {
    const { client } = recordingClient({
      tables: {
        enrollments: { data: [{ student_id: "s1" }, { student_id: "s2" }, { student_id: "s3" }] },
        pending_enrollments: { data: [{ email: "w@x.test" }] },
        users_public: {
          data: [
            { id: "s1", display_name: "Zed" },
            { id: "s2", display_name: "Ann" },
            { id: "s3", display_name: " " },
          ],
        },
      },
    });
    const roster = await loadRoster(client, ROOM);
    expect(roster.students.map((s) => s.name)).toEqual(["Ann", "Student 3", "Zed"]);
    expect(roster.pending).toBe(1);
  });
});

describe("routes", () => {
  const post = async (path: "students" | "join-code" | "join", body: unknown, id = ROOM) => {
    if (path === "join") {
      const { POST } = await import("@/app/api/classrooms/join/route");
      return POST(
        new NextRequest("http://localhost/api/classrooms/join", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    }
    const route =
      path === "students"
        ? await import("@/app/api/classrooms/[id]/students/route")
        : await import("@/app/api/classrooms/[id]/join-code/route");
    return route.POST(
      new NextRequest(`http://localhost/api/classrooms/${id}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) } as never,
    );
  };

  it("need a signed-in user", async () => {
    expect((await post("students", { emails: "a@x.test" })).status).toBe(401);
    expect((await post("join-code", {})).status).toBe(401);
    expect((await post("join", { code: "ABC" })).status).toBe(401);
  });

  it("add students from a list and return the report", async () => {
    mocks.userId = "u1";
    mocks.client = recordingClient({
      rpc: { add_students_by_email: { data: [{ student_email: "a@x.test", outcome: "added" }] } },
    }).client;
    const response = await post("students", { emails: "a@x.test" });
    expect(await response.json()).toEqual({ added: 1, already: 0, rejected: [] });
  });

  it("require some input and a real class id", async () => {
    mocks.userId = "u1";
    mocks.client = recordingClient().client;
    expect((await post("students", {})).status).toBe(400);
    expect((await post("students", { emails: "a@x.test" }, "nope")).status).toBe(404);
  });

  it("join a class by code, and limit how fast codes can be tried", async () => {
    mocks.userId = "u-join";
    mocks.client = recordingClient({ rpc: { join_classroom: { data: ROOM } } }).client;
    expect((await post("join", { code: "ABC234" })).status).toBe(200);
    expect((await post("join", { code: "" })).status).toBe(400);
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await post("join", { code: "ABC234" })).status;
    expect(last).toBe(429);
  });
});

describe("AddStudents", () => {
  const props = { classroomId: ROOM, joinCode: "ABC234", archived: false };
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("has no accessibility violations", async () => {
    const { container } = render(<AddStudents {...props} />);
    await expectNoAxeViolations(container);
  });

  it("shows the class code so it can be read out", () => {
    render(<AddStudents {...props} />);
    expect(screen.getByLabelText("Class code A B C 2 3 4")).toBeTruthy();
  });

  it("asks for addresses before sending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<AddStudents {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Add students" }));
    expect(screen.getByText("Paste some email addresses or choose a CSV file.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports what was added and lists rows that could not be used", async () => {
    answer({
      added: 2,
      already: 1,
      rejected: [{ line: 4, value: "oops", reason: "This is not a valid email address." }],
    });
    render(<AddStudents {...props} />);
    await userEvent.type(screen.getByLabelText("Email addresses"), "a@x.test");
    await userEvent.click(screen.getByRole("button", { name: "Add students" }));
    const region = await screen.findByRole("region", { name: "Result of adding students" });
    expect(region.textContent).toMatch(/2\s*added,\s*1\s*already/);
    const table = within(region).getByRole("table", { name: "Rows that could not be used" });
    expect(within(table).getByText("oops")).toBeTruthy();
    expect(within(table).getByText("4")).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("sends the contents of a chosen CSV file", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ added: 1, already: 0, rejected: [] })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<AddStudents {...props} />);
    const file = new File(["email\na@x.test"], "roster.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Or upload a CSV file"), file);
    expect(await screen.findByText("Selected: roster.csv")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add students" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ csv: "email\na@x.test" });
  });

  it("makes a new code and shows it", async () => {
    answer({ joinCode: "NEW234" });
    render(<AddStudents {...props} />);
    await userEvent.click(screen.getByRole("button", { name: "Make a new code" }));
    expect(await screen.findByText("NEW234")).toBeTruthy();
  });

  it("shows a server error", async () => {
    answer({ error: { code: "archived", message: "This class is archived." } }, 409);
    render(<AddStudents {...props} />);
    await userEvent.type(screen.getByLabelText("Email addresses"), "a@x.test");
    await userEvent.click(screen.getByRole("button", { name: "Add students" }));
    expect(await screen.findByText("This class is archived.")).toBeTruthy();
  });

  it("hides the email form for an archived class but keeps the code", () => {
    render(<AddStudents {...props} archived />);
    expect(screen.queryByLabelText("Email addresses")).toBeNull();
    expect(screen.getByText("ABC234")).toBeTruthy();
  });
});

describe("JoinClassForm", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(<JoinClassForm />);
    await expectNoAxeViolations(container);
  });

  it("asks for a code first", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<JoinClassForm />);
    await userEvent.click(screen.getByRole("button", { name: "Join class" }));
    expect(screen.getByText("Enter the class code.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("joins and refreshes the lessons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ classroomId: ROOM }))),
    );
    render(<JoinClassForm />);
    await userEvent.type(screen.getByLabelText("Class code"), "abc234");
    await userEvent.click(screen.getByRole("button", { name: "Join class" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("explains a wrong code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "code_not_found",
                message: "We could not find a class with that code.",
              },
            }),
            {
              status: 404,
            },
          ),
      ),
    );
    render(<JoinClassForm />);
    await userEvent.type(screen.getByLabelText("Class code"), "zzzzzz");
    await userEvent.click(screen.getByRole("button", { name: "Join class" }));
    expect(await screen.findByText("We could not find a class with that code.")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
