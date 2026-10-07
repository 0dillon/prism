// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassroomSettings } from "@/app/teach/classrooms/[id]/ClassroomSettings";
import { CreateClassroomForm } from "@/app/teach/classrooms/CreateClassroomForm";
import {
  CreateClassroomRequest,
  UpdateClassroomRequest,
  createClassroom,
  getClassroom,
  listClassrooms,
  updateClassroom,
  type ClassroomSummary,
} from "@/lib/classrooms/service";
import { expectNoAxeViolations } from "../a11y";
import { callsOn, opsNamed, recordingClient } from "../fixtures/recording-supabase";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  userId: null as string | null,
  client: null as unknown,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
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

const ORG = "11111111-1111-4111-8111-111111111111";
const ROOM = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const row = (over: Record<string, unknown> = {}) => ({
  id: ROOM,
  org_id: ORG,
  name: "Year 5",
  grade: "5",
  subject: null,
  join_code: "ABCDEF",
  archived_at: null,
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.push.mockReset();
  mocks.refresh.mockReset();
  mocks.userId = null;
  mocks.client = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("request schemas", () => {
  it("trim the text and drop blanks", () => {
    expect(
      CreateClassroomRequest.parse({ orgId: ORG, name: "  Year 5 ", grade: "  ", subject: " Art" }),
    ).toEqual({
      orgId: ORG,
      name: "Year 5",
      grade: undefined,
      subject: "Art",
    });
  });

  it("need a name and a real organization id", () => {
    expect(CreateClassroomRequest.safeParse({ orgId: ORG, name: " " }).success).toBe(false);
    expect(CreateClassroomRequest.safeParse({ orgId: "x", name: "A" }).success).toBe(false);
  });

  it("accept a partial update but not an empty one", () => {
    expect(UpdateClassroomRequest.safeParse({ archived: true }).success).toBe(true);
    expect(UpdateClassroomRequest.safeParse({}).success).toBe(false);
  });
});

describe("classroom service", () => {
  it("creates through the database function so the code is made there", async () => {
    const { client, rpcCalls } = recordingClient({ rpc: { create_classroom: { data: ROOM } } });
    expect(await createClassroom(client, { orgId: ORG, name: "Year 5", grade: "5" })).toEqual({
      id: ROOM,
    });
    expect(rpcCalls[0]).toEqual({
      name: "create_classroom",
      args: { p_org: ORG, p_name: "Year 5", p_grade: "5", p_subject: undefined },
    });
  });

  it("explains a refusal to create in a school the teacher is not in", async () => {
    const { client } = recordingClient({
      rpc: { create_classroom: { error: { code: "42501", message: "x" } } },
    });
    await expect(createClassroom(client, { orgId: ORG, name: "A" })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });
  });

  it("lists only the teacher's own live classrooms, with student counts", async () => {
    const { client, calls } = recordingClient({
      tables: {
        classrooms: { data: [row(), row({ id: "r2", name: "Year 6" })] },
        enrollments: {
          data: [{ classroom_id: ROOM }, { classroom_id: ROOM }, { classroom_id: "r2" }],
        },
      },
    });
    const list = await listClassrooms(client, USER);
    expect(list.map((c) => [c.name, c.students])).toEqual([
      ["Year 5", 2],
      ["Year 6", 1],
    ]);
    const [classroomCall] = callsOn(calls, "classrooms");
    expect(opsNamed(classroomCall, "eq")).toEqual([["teacher_id", USER]]);
    expect(opsNamed(classroomCall, "is")).toEqual([["archived_at", null]]);
  });

  it("lists the archived ones when asked", async () => {
    const { client, calls } = recordingClient({ tables: { classrooms: { data: [] } } });
    await listClassrooms(client, USER, { archived: true });
    expect(opsNamed(callsOn(calls, "classrooms")[0], "not")).toEqual([["archived_at", "is", null]]);
  });

  it("treats someone else's classroom as not found", async () => {
    const { client } = recordingClient({ tables: { classrooms: { data: [] } } });
    await expect(getClassroom(client, USER, ROOM)).rejects.toMatchObject({ status: 404 });
  });

  it("archives by setting a time, and restores by clearing it", async () => {
    const archive = recordingClient({
      tables: { classrooms: { data: [row({ archived_at: "2026-10-07T00:00:00Z" })] } },
    });
    const archived = await updateClassroom(archive.client, USER, ROOM, { archived: true });
    expect(archived.archived).toBe(true);
    const patch = opsNamed(callsOn(archive.calls, "classrooms")[0], "update")[0][0] as Record<
      string,
      unknown
    >;
    expect(typeof patch.archived_at).toBe("string");

    const restore = recordingClient({ tables: { classrooms: { data: [row()] } } });
    await updateClassroom(restore.client, USER, ROOM, { archived: false });
    expect(opsNamed(callsOn(restore.calls, "classrooms")[0], "update")[0][0]).toEqual({
      archived_at: null,
    });
  });

  it("changes only what it is given, and scopes the update to the teacher", async () => {
    const { client, calls } = recordingClient({
      tables: { classrooms: { data: [row({ name: "New" })] } },
    });
    await updateClassroom(client, USER, ROOM, { name: "New", subject: "" });
    const call = callsOn(calls, "classrooms")[0];
    expect(opsNamed(call, "update")[0][0]).toEqual({ name: "New", subject: null });
    expect(opsNamed(call, "eq")).toEqual([
      ["id", ROOM],
      ["teacher_id", USER],
    ]);
  });

  it("says not found when the update touched nothing", async () => {
    const { client } = recordingClient({ tables: { classrooms: { data: [] } } });
    await expect(updateClassroom(client, USER, ROOM, { name: "X" })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("classroom routes", () => {
  const create = async (body: unknown) => {
    const { POST } = await import("@/app/api/classrooms/route");
    return POST(
      new NextRequest("http://localhost/api/classrooms", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  };
  const patch = async (body: unknown, id = ROOM) => {
    const { PATCH } = await import("@/app/api/classrooms/[id]/route");
    return PATCH(
      new NextRequest(`http://localhost/api/classrooms/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) } as never,
    );
  };

  it("need a signed-in user", async () => {
    expect((await create({ orgId: ORG, name: "A" })).status).toBe(401);
    expect((await patch({ archived: true })).status).toBe(401);
  });

  it("create a class and return its id", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient({ rpc: { create_classroom: { data: ROOM } } }).client;
    const response = await create({ orgId: ORG, name: "Year 5" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: ROOM });
  });

  it("validate the body and the id", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient().client;
    expect((await create({ orgId: ORG })).status).toBe(400);
    expect((await patch({}, ROOM)).status).toBe(400);
    const bad = await patch({ archived: true }, "nope");
    expect(bad.status).toBe(404);
    expect((await bad.json()).error.message).toBe("Class not found.");
  });

  it("update a class", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient({
      tables: { classrooms: { data: [row({ name: "Renamed" })] } },
    }).client;
    const response = await patch({ name: "Renamed" });
    expect((await response.json()).name).toBe("Renamed");
  });
});

describe("CreateClassroomForm", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(<CreateClassroomForm orgs={[{ id: ORG, name: "Oak" }]} />);
    await expectNoAxeViolations(container);
  });

  it("does not ask which school when there is only one", () => {
    render(<CreateClassroomForm orgs={[{ id: ORG, name: "Oak" }]} />);
    expect(screen.queryByLabelText("School")).toBeNull();
  });

  it("asks which school when there are several", () => {
    render(
      <CreateClassroomForm
        orgs={[
          { id: ORG, name: "Oak" },
          { id: "o2", name: "Elm" },
        ]}
      />,
    );
    expect(screen.getByLabelText("School")).toBeTruthy();
  });

  it("asks for a name first", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<CreateClassroomForm orgs={[{ id: ORG, name: "Oak" }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Create class" }));
    expect(screen.getByText("Enter a name for the class.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("creates the class and opens it", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ id: ROOM }), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<CreateClassroomForm orgs={[{ id: ORG, name: "Oak" }]} />);
    await userEvent.type(screen.getByLabelText("Class name"), "Year 5");
    await userEvent.type(screen.getByLabelText("Grade (optional)"), "5");
    await userEvent.click(screen.getByRole("button", { name: "Create class" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith(`/teach/classrooms/${ROOM}`));
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body).toMatchObject({ orgId: ORG, name: "Year 5", grade: "5" });
  });
});

describe("ClassroomSettings", () => {
  const summary = (over: Partial<ClassroomSummary> = {}): ClassroomSummary => ({
    id: ROOM,
    orgId: ORG,
    name: "Year 5",
    grade: "5",
    subject: null,
    joinCode: "ABCDEF",
    archived: false,
    students: 3,
    ...over,
  });
  const ok = () => vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));

  it("has no accessibility violations", async () => {
    const { container } = render(<ClassroomSettings classroom={summary()} />);
    await expectNoAxeViolations(container);
  });

  it("saves edits with a PATCH and refreshes the page", async () => {
    const fetchSpy = ok();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ClassroomSettings classroom={summary()} />);
    const name = screen.getByLabelText("Class name");
    await userEvent.clear(name);
    await userEvent.type(name, "Year 5 Blue");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/classrooms/${ROOM}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({ name: "Year 5 Blue", grade: "5" });
  });

  it("asks before archiving, then archives and returns to the list", async () => {
    const fetchSpy = ok();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ClassroomSettings classroom={summary()} />);
    await userEvent.click(screen.getByRole("button", { name: "Archive this class" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Archive" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/teach/classrooms"));
    expect(
      JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({
      archived: true,
    });
  });

  it("offers to restore an archived class", async () => {
    const fetchSpy = ok();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ClassroomSettings classroom={summary({ archived: true })} />);
    await userEvent.click(screen.getByRole("button", { name: "Restore this class" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(
      JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({
      archived: false,
    });
  });

  it("shows a failure and does not refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "x", message: "Could not save." } }), {
            status: 500,
          }),
      ),
    );
    render(<ClassroomSettings classroom={summary()} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Could not save.")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
