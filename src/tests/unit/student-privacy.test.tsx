// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareSettingsToggle } from "@/app/learn/ShareSettingsToggle";
import { formatLastActive, loadStudentDetail } from "@/lib/classrooms/student";
import { SETTING_DESCRIPTIONS, describeProfile } from "@/lib/profile/describe";
import { presetProfile } from "@/lib/profile/presets";
import { loadSharing, setProfileSharing } from "@/lib/profile/sharing";
import { expectNoAxeViolations } from "../a11y";
import { callsOn, recordingClient } from "../fixtures/recording-supabase";

const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  client: null as unknown,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`redirect:${to}`), { to });
  },
  notFound: () => {
    throw Object.assign(new Error("notFound"), { kind: "notFound" });
  },
  useRouter: () => ({ refresh: () => {} }),
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

import StudentPage from "@/app/teach/classrooms/[id]/students/[studentId]/page";

const CLASS = "22222222-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";
const LESSON = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.userId = null;
  mocks.client = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const progressRow = (over: Record<string, unknown> = {}) => ({
  lesson_id: LESSON,
  mastered_concepts: 3,
  total_concepts: 5,
  answered: 8,
  correct: 6,
  active_seconds: 600,
  last_active_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  ...over,
});

function teacherClient(options: { profile?: unknown; enrolled?: boolean; rows?: unknown[] } = {}) {
  return recordingClient({
    tables: {
      enrollments: { data: options.enrolled === false ? [] : [{ student_id: STUDENT }] },
      v_classroom_student_progress: { data: options.rows ?? [progressRow()] },
      users_public: { data: [{ display_name: "Maya" }] },
      lessons: { data: [{ id: LESSON, title: "The Water Cycle" }] },
    },
    rpc: { get_shared_profile: { data: options.profile ?? null } },
  });
}

describe("describeProfile", () => {
  it("describes every setting in words, with no raw keys or values", () => {
    const lines = describeProfile(presetProfile("hyper_focus"));
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) {
      expect(line).not.toMatch(/[a-z]+\.[a-zA-Z]+/);
      expect(line).not.toMatch(/\[object|undefined|null/);
    }
  });

  it("covers every setting the profile has, apart from the preset label", () => {
    const lines = describeProfile(presetProfile("standard"));
    expect(lines).toHaveLength(Object.keys(SETTING_DESCRIPTIONS).length - 1);
  });

  it("leaves out a setting the profile does not have", () => {
    expect(describeProfile({ layout: "cards" })).toEqual(["Showing the lesson as cards"]);
    expect(describeProfile(null)).toEqual([]);
  });
});

describe("formatLastActive", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");

  it("says Today, Yesterday, or the date", () => {
    expect(formatLastActive("2026-10-07T01:00:00Z", now)).toBe("Today");
    expect(formatLastActive("2026-10-06T08:00:00Z", now)).toBe("Yesterday");
    expect(formatLastActive("2026-10-01T08:00:00Z", now)).toBe("1 Oct 2026");
  });

  it("says Not started when there is no activity", () => {
    expect(formatLastActive(null, now)).toBe("Not started");
  });
});

describe("loadStudentDetail", () => {
  it("shows progress, time and last activity for each assigned lesson", async () => {
    const detail = await loadStudentDetail(teacherClient().client, CLASS, STUDENT);
    expect(detail.name).toBe("Maya");
    expect(detail.lessons).toEqual([
      {
        lessonId: LESSON,
        title: "The Water Cycle",
        mastered: 3,
        total: 5,
        answered: 8,
        correct: 6,
        activeSeconds: 600,
        lastActive: expect.stringMatching(/^\d{1,2} \w{3} \d{4}$/),
      },
    ]);
  });

  it("does not show the Render Profile when the student has not opted in", async () => {
    const { client, calls } = teacherClient({ profile: null });
    const detail = await loadStudentDetail(client, CLASS, STUDENT);
    expect(detail.sharedSettings).toBeNull();
    // The profile table is never read directly: the database function is the only way in.
    expect(callsOn(calls, "render_profiles")).toEqual([]);
  });

  it("shows the profile in words when the student has opted in", async () => {
    const detail = await loadStudentDetail(
      teacherClient({ profile: presetProfile("voice_native") }).client,
      CLASS,
      STUDENT,
    );
    expect(detail.sharedSettings).toContain("Showing the lesson as conversation");
  });

  it("treats a shared profile that no longer validates as not shared, instead of guessing", async () => {
    const detail = await loadStudentDetail(
      teacherClient({ profile: { layout: "nonsense" } }).client,
      CLASS,
      STUDENT,
    );
    expect(detail.sharedSettings).toBeNull();
  });

  it("is not found for a student who is not on the roster", async () => {
    await expect(
      loadStudentDetail(teacherClient({ enrolled: false }).client, CLASS, STUDENT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("copes with a class that has no lessons yet", async () => {
    const detail = await loadStudentDetail(teacherClient({ rows: [] }).client, CLASS, STUDENT);
    expect(detail.lessons).toEqual([]);
  });

  it("says plainly when the progress view cannot be read", async () => {
    const { client } = recordingClient({
      tables: {
        enrollments: { data: [{ student_id: STUDENT }] },
        v_classroom_student_progress: { error: { message: "secret" } },
      },
    });
    const error = await loadStudentDetail(client, CLASS, STUDENT).catch((e) => e);
    expect(error).toMatchObject({ status: 500, code: "read_failed" });
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("the student page", () => {
  const show = async (client: ReturnType<typeof teacherClient>["client"]) => {
    mocks.userId = "teacher-1";
    mocks.client = client;
    render(
      await StudentPage({
        params: Promise.resolve({ id: CLASS, studentId: STUDENT }),
      } as never),
    );
  };

  it("says the student has not shared, and shows no settings", async () => {
    await show(teacherClient().client);
    expect(screen.getByText(/has not shared their settings with teachers/)).toBeTruthy();
    expect(screen.queryByText(/Showing the lesson as/)).toBeNull();
    expect(screen.queryByText(/Font:/)).toBeNull();
  });

  it("shows the settings, called preferences, when the student has shared them", async () => {
    await show(teacherClient({ profile: presetProfile("visual_sign") }).client);
    expect(screen.getByText(/They are preferences, not a diagnosis/)).toBeTruthy();
    expect(screen.getByText("Showing the lesson as pictures and signs")).toBeTruthy();
  });

  it("shows each lesson's progress as a labelled bar with the numbers in words", async () => {
    await show(teacherClient().client);
    const bar = screen.getByRole("progressbar", { name: "Progress in The Water Cycle" });
    expect(bar.getAttribute("value")).toBe("60");
    expect(screen.getByText("3 of 5 ideas mastered")).toBeTruthy();
    expect(screen.getByText(/6 of 8 answers right/)).toBeTruthy();
    expect(screen.getByText(/Last worked:/)).toBeTruthy();
  });

  it("has no accessibility violations", async () => {
    mocks.userId = "teacher-1";
    mocks.client = teacherClient({ profile: presetProfile("standard") }).client;
    const { container } = render(
      await StudentPage({ params: Promise.resolve({ id: CLASS, studentId: STUDENT }) } as never),
    );
    await expectNoAxeViolations(container);
  });

  it("is not found for a student not on the roster, and sends a signed-out visitor to sign in", async () => {
    mocks.userId = "teacher-1";
    mocks.client = teacherClient({ enrolled: false }).client;
    await expect(
      StudentPage({ params: Promise.resolve({ id: CLASS, studentId: STUDENT }) } as never),
    ).rejects.toMatchObject({ kind: "notFound" });
    mocks.userId = null;
    await expect(
      StudentPage({ params: Promise.resolve({ id: CLASS, studentId: STUDENT }) } as never),
    ).rejects.toMatchObject({ to: expect.stringContaining("/sign-in?next=") });
  });

  it("offers to record consent when the student is waiting for it", async () => {
    mocks.userId = "teacher-1";
    const base = teacherClient();
    mocks.client = recordingClient({
      tables: {
        enrollments: { data: [{ student_id: STUDENT }] },
        v_classroom_student_progress: { data: [progressRow()] },
        users_public: { data: [{ display_name: "Maya" }] },
        lessons: { data: [{ id: LESSON, title: "The Water Cycle" }] },
      },
      rpc: {
        get_shared_profile: { data: null },
        pending_consents: { data: [{ student_id: STUDENT }] },
      },
    }).client;
    void base;
    render(
      await StudentPage({ params: Promise.resolve({ id: CLASS, studentId: STUDENT }) } as never),
    );
    expect(screen.getByRole("heading", { name: "Waiting for a parent or guardian" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Record that the school holds consent" }),
    ).toBeTruthy();
  });

  it("does not offer it for a student who does not need it", async () => {
    await show(teacherClient().client);
    expect(screen.queryByRole("heading", { name: "Waiting for a parent or guardian" })).toBeNull();
  });

  it("is not found for ids that are not ids", async () => {
    mocks.userId = "teacher-1";
    await expect(
      StudentPage({ params: Promise.resolve({ id: "x", studentId: "y" }) } as never),
    ).rejects.toMatchObject({ kind: "notFound" });
  });
});

describe("setProfileSharing and loadSharing", () => {
  it("turns sharing on or off through the database function", async () => {
    const { client, rpcCalls } = recordingClient({ rpc: { set_profile_sharing: { data: true } } });
    expect(await setProfileSharing(client, true)).toEqual({ share: true });
    expect(rpcCalls[0]).toEqual({ name: "set_profile_sharing", args: { p_share: true } });
    const off = recordingClient({ rpc: { set_profile_sharing: { data: false } } });
    expect(await setProfileSharing(off.client, false)).toEqual({ share: false });
  });

  it("asks a learner with no saved settings to save them first", async () => {
    const { client } = recordingClient({
      rpc: { set_profile_sharing: { error: { code: "P0002", message: "x" } } },
    });
    await expect(setProfileSharing(client, true)).rejects.toMatchObject({
      status: 409,
      code: "no_profile",
    });
  });

  it("reports other failures without the database message", async () => {
    const { client } = recordingClient({
      rpc: { set_profile_sharing: { error: { code: "XX000", message: "secret" } } },
    });
    const error = await setProfileSharing(client, true).catch((e) => e);
    expect(error.status).toBe(500);
    expect(error.message).not.toMatch(/secret/);
  });

  it("reads the current choice, which is off when there are no saved settings", async () => {
    const on = recordingClient({
      tables: { render_profiles: { data: [{ share_with_teachers: true }] } },
    });
    expect(await loadSharing(on.client, STUDENT)).toBe(true);
    const none = recordingClient({ tables: { render_profiles: { data: [] } } });
    expect(await loadSharing(none.client, STUDENT)).toBe(false);
  });
});

describe("PUT /api/profile/sharing", () => {
  const put = async (body: unknown) => {
    const { PUT } = await import("@/app/api/profile/sharing/route");
    return PUT(
      new NextRequest("http://localhost/api/profile/sharing", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    );
  };

  it("needs a signed-in user and a boolean", async () => {
    expect((await put({ share: true })).status).toBe(401);
    mocks.userId = STUDENT;
    mocks.client = recordingClient().client;
    expect((await put({ share: "yes" })).status).toBe(400);
    expect((await put({})).status).toBe(400);
  });

  it("changes the choice", async () => {
    mocks.userId = STUDENT;
    mocks.client = recordingClient({ rpc: { set_profile_sharing: { data: true } } }).client;
    const response = await put({ share: true });
    expect(await response.json()).toEqual({ share: true });
  });
});

describe("ShareSettingsToggle", () => {
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("has no accessibility violations", async () => {
    const { container } = render(<ShareSettingsToggle initial={false} />);
    await expectNoAxeViolations(container);
  });

  it("is off unless the learner already turned it on", () => {
    const { unmount } = render(<ShareSettingsToggle initial={false} />);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Share my settings with my teachers",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    unmount();
    render(<ShareSettingsToggle initial />);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Share my settings with my teachers",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it("says what is and is not shared, and that each change is recorded", () => {
    render(<ShareSettingsToggle initial={false} />);
    const hint = screen.getByText(/Off by default/);
    expect(hint.textContent).toMatch(/layout and text size/);
    expect(hint.textContent).toMatch(/always see your progress/);
    expect(hint.textContent).toMatch(/each change is recorded/);
    expect(screen.getByRole("checkbox").getAttribute("aria-describedby")).toBe(
      hint.getAttribute("id"),
    );
  });

  it("turns sharing on with a PUT and keeps it on", async () => {
    answer({ share: true });
    render(<ShareSettingsToggle initial={false} />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    await userEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    const fetchSpy = vi.mocked(fetch);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/profile/sharing");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ share: true });
  });

  it("stays where it was and explains when the change fails", async () => {
    answer(
      { error: { code: "no_profile", message: "Save your settings first, then you can choose." } },
      409,
    );
    render(<ShareSettingsToggle initial={false} />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    await userEvent.click(box);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText(/Save your settings first/)).toBeTruthy();
    expect(box.checked).toBe(false);
  });
});
