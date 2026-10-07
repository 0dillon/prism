// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssignedLessons } from "@/app/teach/classrooms/[id]/AssignedLessons";
import { AssignPanel } from "@/app/teach/lessons/[id]/progress/AssignPanel";
import {
  AssignRequest,
  assignLesson,
  compareDue,
  dueAtFor,
  formatDue,
  listClassroomAssignments,
  unassignLesson,
} from "@/lib/assignments/service";
import { expectNoAxeViolations } from "../a11y";
import { callsOn, opsNamed, recordingClient } from "../fixtures/recording-supabase";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  userId: null as string | null,
  client: null as unknown,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        mocks.userId ? { data: { user: { id: mocks.userId } } } : { data: { user: null } },
    },
    ...(mocks.client as object),
  }),
}));

const USER = "33333333-3333-4333-8333-333333333333";
const LESSON = "11111111-1111-4111-8111-111111111111";
const C1 = "22222222-2222-4222-8222-222222222222";
const C2 = "44444444-4444-4444-8444-444444444444";

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

describe("due dates", () => {
  it("end at the last second of the chosen day", () => {
    expect(dueAtFor("2026-10-14")).toBe("2026-10-14T23:59:59.000Z");
    expect(dueAtFor(null)).toBeNull();
    expect(dueAtFor(undefined)).toBeNull();
  });

  it("are written in words that do not depend on the reader's time zone", () => {
    expect(formatDue("2026-10-14T23:59:59.000Z")).toBe("Due 14 Oct 2026");
    expect(formatDue("2026-01-01T23:59:59.000Z")).toBe("Due 1 Jan 2026");
  });

  it("sort soonest first with undated last", () => {
    const sorted = ["2026-12-01", null, "2026-11-01"].sort(compareDue);
    expect(sorted).toEqual(["2026-11-01", "2026-12-01", null]);
  });
});

describe("AssignRequest", () => {
  const base = { lessonId: LESSON, classroomIds: [C1] };

  it("accepts a lesson, some classes and an optional date", () => {
    expect(AssignRequest.safeParse(base).success).toBe(true);
    expect(AssignRequest.safeParse({ ...base, dueDate: "2026-10-14" }).success).toBe(true);
    expect(AssignRequest.safeParse({ ...base, dueDate: null }).success).toBe(true);
  });

  it("refuses no classes, a bad id or a malformed date", () => {
    expect(AssignRequest.safeParse({ ...base, classroomIds: [] }).success).toBe(false);
    expect(AssignRequest.safeParse({ ...base, classroomIds: ["x"] }).success).toBe(false);
    expect(AssignRequest.safeParse({ ...base, dueDate: "14/10/2026" }).success).toBe(false);
    expect(AssignRequest.safeParse({ ...base, dueDate: "2026-02-31" }).success).toBe(false);
  });
});

describe("assignLesson", () => {
  const lesson = (over: Record<string, unknown> = {}) => ({
    lessons: { data: [{ id: LESSON, owner_id: USER, status: "published", ...over }] },
  });

  it("assigns to every class named, with the due date, in one write", async () => {
    const { client, calls } = recordingClient({
      tables: {
        ...lesson(),
        classrooms: { data: [{ id: C1 }, { id: C2 }] },
        assignments: { data: [] },
      },
    });
    const result = await assignLesson(client, USER, {
      lessonId: LESSON,
      classroomIds: [C1, C2, C1],
      dueDate: "2026-10-14",
    });
    expect(result).toEqual({ assigned: 2 });
    const [write] = callsOn(calls, "assignments");
    const [rows, options] = opsNamed(write, "upsert")[0];
    expect(rows).toEqual([
      { classroom_id: C1, lesson_id: LESSON, due_at: "2026-10-14T23:59:59.000Z" },
      { classroom_id: C2, lesson_id: LESSON, due_at: "2026-10-14T23:59:59.000Z" },
    ]);
    expect(options).toEqual({ onConflict: "classroom_id,lesson_id" });
  });

  it("asks only for the teacher's own live classes", async () => {
    const { client, calls } = recordingClient({
      tables: { ...lesson(), classrooms: { data: [{ id: C1 }] } },
    });
    await assignLesson(client, USER, { lessonId: LESSON, classroomIds: [C1] });
    const call = callsOn(calls, "classrooms")[0];
    expect(opsNamed(call, "eq")).toEqual([["teacher_id", USER]]);
    expect(opsNamed(call, "is")).toEqual([["archived_at", null]]);
  });

  it("clears a due date when none is given", async () => {
    const { client, calls } = recordingClient({
      tables: { ...lesson(), classrooms: { data: [{ id: C1 }] } },
    });
    await assignLesson(client, USER, { lessonId: LESSON, classroomIds: [C1], dueDate: null });
    const rows = opsNamed(callsOn(calls, "assignments")[0], "upsert")[0][0] as {
      due_at: unknown;
    }[];
    expect(rows[0].due_at).toBeNull();
  });

  it("refuses someone else's lesson as not found, and a draft as not published", async () => {
    await expect(
      assignLesson(recordingClient({ tables: lesson({ owner_id: "someone-else" }) }).client, USER, {
        lessonId: LESSON,
        classroomIds: [C1],
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      assignLesson(recordingClient({ tables: lesson({ status: "needs_review" }) }).client, USER, {
        lessonId: LESSON,
        classroomIds: [C1],
      }),
    ).rejects.toMatchObject({ status: 409, code: "not_published" });
  });

  it("refuses the whole request if any class is not the teacher's", async () => {
    const { client, calls } = recordingClient({
      tables: { ...lesson(), classrooms: { data: [{ id: C1 }] } },
    });
    await expect(
      assignLesson(client, USER, { lessonId: LESSON, classroomIds: [C1, C2] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(callsOn(calls, "assignments")).toEqual([]);
  });

  it("reports a failed write without exposing the database message", async () => {
    const { client } = recordingClient({
      tables: {
        ...lesson(),
        classrooms: { data: [{ id: C1 }] },
        assignments: { error: { message: "secret detail" } },
      },
    });
    const error = await assignLesson(client, USER, { lessonId: LESSON, classroomIds: [C1] }).catch(
      (e) => e,
    );
    expect(error).toMatchObject({ status: 500, code: "assign_failed" });
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("unassignLesson and listClassroomAssignments", () => {
  it("removes one lesson from one of the teacher's classes", async () => {
    const { client, calls } = recordingClient({ tables: { classrooms: { data: [{ id: C1 }] } } });
    await unassignLesson(client, USER, { lessonId: LESSON, classroomId: C1 });
    const call = callsOn(calls, "assignments")[0];
    expect(opsNamed(call, "eq")).toEqual([
      ["classroom_id", C1],
      ["lesson_id", LESSON],
    ]);
  });

  it("will not touch another teacher's class", async () => {
    const { client, calls } = recordingClient({ tables: { classrooms: { data: [] } } });
    await expect(
      unassignLesson(client, USER, { lessonId: LESSON, classroomId: C1 }),
    ).rejects.toMatchObject({ status: 404 });
    expect(callsOn(calls, "assignments")).toEqual([]);
  });

  it("lists a class's lessons with titles, soonest due first", async () => {
    const { client } = recordingClient({
      tables: {
        assignments: {
          data: [
            { lesson_id: "l-b", due_at: null },
            { lesson_id: "l-a", due_at: "2026-10-20T23:59:59.000Z" },
          ],
        },
        lessons: {
          data: [
            { id: "l-a", title: "Fractions" },
            { id: "l-b", title: "Water" },
          ],
        },
      },
    });
    const list = await listClassroomAssignments(client, C1);
    expect(list.map((a) => a.title)).toEqual(["Fractions", "Water"]);
  });
});

describe("POST and DELETE /api/assignments", () => {
  const call = async (method: "POST" | "DELETE", body: unknown) => {
    const route = await import("@/app/api/assignments/route");
    return route[method](
      new NextRequest("http://localhost/api/assignments", { method, body: JSON.stringify(body) }),
    );
  };

  it("need a signed-in user", async () => {
    expect((await call("POST", { lessonId: LESSON, classroomIds: [C1] })).status).toBe(401);
    expect((await call("DELETE", { lessonId: LESSON, classroomId: C1 })).status).toBe(401);
  });

  it("assign and report how many classes", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient({
      tables: {
        lessons: { data: [{ id: LESSON, owner_id: USER, status: "published" }] },
        classrooms: { data: [{ id: C1 }] },
      },
    }).client;
    const response = await call("POST", { lessonId: LESSON, classroomIds: [C1] });
    expect(await response.json()).toEqual({ assigned: 1 });
  });

  it("validate the body", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient().client;
    expect((await call("POST", { lessonId: LESSON, classroomIds: [] })).status).toBe(400);
    expect((await call("DELETE", { lessonId: "nope" })).status).toBe(400);
  });
});

describe("AssignPanel", () => {
  const classrooms = [
    { id: C1, name: "Year 5", assigned: false, dueLabel: null },
    { id: C2, name: "Year 6", assigned: true, dueLabel: "Due 14 Oct 2026" },
  ];

  it("has no accessibility violations", async () => {
    const { container } = render(<AssignPanel lessonId={LESSON} classrooms={classrooms} />);
    await expectNoAxeViolations(container);
  });

  it("shows which classes already have the lesson, and ticks them", () => {
    render(<AssignPanel lessonId={LESSON} classrooms={classrooms} />);
    expect((screen.getByRole("checkbox", { name: /Year 6/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByText(/already assigned, due 14 oct 2026/)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: /Year 5/ }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("points a teacher with no classes to create one", () => {
    render(<AssignPanel lessonId={LESSON} classrooms={[]} />);
    expect(screen.getByText(/no classes yet/)).toBeTruthy();
  });

  it("asks for a class before sending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<AssignPanel lessonId={LESSON} classrooms={[classrooms[0]]} />);
    await userEvent.click(screen.getByRole("button", { name: "Assign lesson" }));
    expect(screen.getByText("Choose at least one class.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the ticked classes and the due date", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ assigned: 2 })));
    vi.stubGlobal("fetch", fetchSpy);
    render(<AssignPanel lessonId={LESSON} classrooms={classrooms} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Year 5/ }));
    await userEvent.type(screen.getByLabelText("Due date (optional)"), "2026-10-14");
    await userEvent.click(screen.getByRole("button", { name: "Assign lesson" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/assignments");
    expect(JSON.parse(init.body as string)).toEqual({
      lessonId: LESSON,
      classroomIds: [C1, C2],
      dueDate: "2026-10-14",
    });
  });

  it("shows why it failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "not_published", message: "Publish the lesson first." },
            }),
            { status: 409 },
          ),
      ),
    );
    render(<AssignPanel lessonId={LESSON} classrooms={classrooms} />);
    await userEvent.click(screen.getByRole("button", { name: "Assign lesson" }));
    expect(await screen.findByText("Publish the lesson first.")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("AssignedLessons", () => {
  const items = [
    { lessonId: LESSON, title: "The Water Cycle", dueLabel: "Due 14 Oct 2026" },
    { lessonId: "l2", title: "Fractions", dueLabel: null },
  ];

  it("has no accessibility violations", async () => {
    const { container } = render(<AssignedLessons classroomId={C1} items={items} />);
    await expectNoAxeViolations(container);
  });

  it("lists each lesson with its due date and a link to its progress", () => {
    render(<AssignedLessons classroomId={C1} items={items} />);
    const link = screen.getByRole("link", { name: "The Water Cycle" });
    expect(link.getAttribute("href")).toBe(`/teach/lessons/${LESSON}/progress`);
    expect(within(link.closest("li")!).getByText(/Due 14 Oct 2026/)).toBeTruthy();
  });

  it("says when nothing is assigned", () => {
    render(<AssignedLessons classroomId={C1} items={[]} />);
    expect(screen.getByText(/Nothing is assigned yet/)).toBeTruthy();
  });

  it("removes a lesson from the class and refreshes", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchSpy);
    render(<AssignedLessons classroomId={C1} items={items} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Take The Water Cycle away from this class" }),
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ lessonId: LESSON, classroomId: C1 });
  });
});
