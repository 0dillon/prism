// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountActions } from "@/app/account/AccountActions";
import { GuardianConsent } from "@/app/consent/[token]/GuardianConsent";
import { ConsentPending } from "@/app/learn/ConsentPending";
import { RecordConsent } from "@/app/teach/classrooms/[id]/students/[studentId]/RecordConsent";
import {
  isPlausibleBirthDate,
  isRealDate,
  needsGuardianConsent,
  todayIso,
} from "@/lib/consent/age";
import { exportMyData, loadDeletionState, requestDeletion } from "@/lib/consent/data-rights";
import {
  GuardianRequest,
  grantGuardianConsent,
  listPendingConsents,
  loadConsent,
  recordSchoolConsent,
  requestGuardianConsent,
} from "@/lib/consent/service";
import type { Mailer } from "@/lib/orgs/mailer";
import { expectNoAxeViolations } from "../a11y";
import { callsOn, opsNamed, recordingClient } from "../fixtures/recording-supabase";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  userId: null as string | null,
  client: null as unknown,
  admin: null as unknown,
  signUp: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: () => {} }),
  redirect: (to: string) => {
    throw Object.assign(new Error(`redirect:${to}`), { to });
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ origin: "https://prism.test" }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        mocks.userId
          ? { data: { user: { id: mocks.userId, user_metadata: { display_name: "Maya" } } } }
          : { data: { user: null } },
      signUp: mocks.signUp,
    },
    ...(mocks.client as object),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));

const USER = "33333333-3333-4333-8333-333333333333";
const STUDENT = "44444444-4444-4444-8444-444444444444";
const TOKEN = "b".repeat(64);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.refresh.mockReset();
  mocks.signUp.mockReset();
  mocks.userId = null;
  mocks.client = null;
  mocks.admin = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("age rules", () => {
  it("recognise real dates only", () => {
    expect(isRealDate("2012-05-14")).toBe(true);
    expect(isRealDate("2012-02-30")).toBe(false);
    expect(isRealDate("2012-5-14")).toBe(false);
    expect(isRealDate("")).toBe(false);
  });

  it("need a guardian until the 13th birthday, to the day", () => {
    const today = "2026-10-07";
    expect(needsGuardianConsent("2013-10-08", today)).toBe(true); // turns 13 tomorrow
    expect(needsGuardianConsent("2013-10-07", today)).toBe(false); // turns 13 today
    expect(needsGuardianConsent("2013-10-06", today)).toBe(false);
    expect(needsGuardianConsent("2020-01-01", today)).toBe(true);
    expect(needsGuardianConsent("1990-01-01", today)).toBe(false);
  });

  it("handle someone born on 29 February", () => {
    expect(needsGuardianConsent("2012-02-29", "2025-02-28")).toBe(true);
    expect(needsGuardianConsent("2012-02-29", "2025-03-01")).toBe(false);
  });

  it("accept only a possible date of birth", () => {
    const today = "2026-10-07";
    expect(isPlausibleBirthDate("2012-05-14", today)).toBe(true);
    expect(isPlausibleBirthDate("2026-10-07", today)).toBe(true);
    expect(isPlausibleBirthDate("2026-10-08", today)).toBe(false);
    expect(isPlausibleBirthDate("1899-12-31", today)).toBe(false);
    expect(isPlausibleBirthDate("2012-02-31", today)).toBe(false);
    expect(todayIso(Date.parse("2026-10-07T23:59:00Z"))).toBe("2026-10-07");
  });
});

describe("signUpAction", () => {
  const form = (over: Record<string, string> = {}) => {
    const data = new FormData();
    const fields = {
      displayName: "Maya",
      email: "maya@example.test",
      birthDate: "2018-03-01",
      password: "correct horse",
      next: "/learn",
      ...over,
    };
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  };
  const run = async (data: FormData) => {
    const { signUpAction } = await import("@/app/(auth)/actions");
    return signUpAction({}, data);
  };

  it("sends the date of birth with the sign-up, so the database sees it at creation", async () => {
    mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await run(form());
    expect(mocks.signUp.mock.calls[0][0].options.data).toEqual({
      display_name: "Maya",
      birth_date: "2018-03-01",
    });
  });

  it("tells a child under 13 that a parent or guardian also needs to agree", async () => {
    mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const state = await run(form({ birthDate: "2018-03-01" }));
    expect(state.message).toMatch(/under 13, a parent or guardian also needs to say yes/);
  });

  it("does not say that to someone old enough", async () => {
    mocks.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const state = await run(form({ birthDate: "1990-03-01" }));
    expect(state.message).toBe("Check your email for a link to confirm your account.");
  });

  it("asks for a real date of birth and does not create the account without it", async () => {
    const missing = await run(form({ birthDate: "" }));
    expect(missing.errors?.birthDate).toBe("Enter your date of birth.");
    const fake = await run(form({ birthDate: "2018-02-31" }));
    expect(fake.errors?.birthDate).toBe("Enter a real date of birth.");
    expect(mocks.signUp).not.toHaveBeenCalled();
  });

  it("puts the date back in the form after an error, but never the password", async () => {
    const state = await run(form({ email: "bad" }));
    expect(state.values).toEqual({
      email: "bad",
      displayName: "Maya",
      birthDate: "2018-03-01",
    });
  });
});

describe("loadConsent", () => {
  it("reads the status, and treats no record as not restricted", async () => {
    const pending = recordingClient({
      tables: {
        user_consents: { data: [{ status: "pending", requested_at: "2026-10-07T10:00:00Z" }] },
      },
    });
    expect(await loadConsent(pending.client, USER)).toEqual({ status: "pending", requested: true });
    const none = recordingClient({ tables: { user_consents: { data: [] } } });
    expect(await loadConsent(none.client, USER)).toEqual({
      status: "not_required",
      requested: false,
    });
    const granted = recordingClient({
      tables: { user_consents: { data: [{ status: "granted", requested_at: null }] } },
    });
    expect(await loadConsent(granted.client, USER)).toEqual({
      status: "granted",
      requested: false,
    });
  });

  it("asks only for the status and the request time, never the date of birth or the address", async () => {
    const { client, calls } = recordingClient({ tables: { user_consents: { data: [] } } });
    await loadConsent(client, USER);
    const selected = opsNamed(callsOn(calls, "user_consents")[0], "select")[0][0] as string;
    expect(selected).not.toMatch(/birth|guardian|token/);
  });
});

describe("requestGuardianConsent", () => {
  const mail = () => {
    const sendGuardianConsent = vi.fn(async () => ({ sent: true }));
    const mailer: Mailer = { sendInvitation: async () => ({ sent: false }), sendGuardianConsent };
    return { mailer, sendGuardianConsent };
  };

  it("puts the link in the guardian's email, and returns nothing a child could use", async () => {
    const { client, rpcCalls } = recordingClient({
      rpc: { request_guardian_consent: { data: TOKEN } },
    });
    const { mailer, sendGuardianConsent } = mail();
    const result = await requestGuardianConsent(
      client,
      { guardianEmail: "Parent@Example.test " },
      "Maya",
      "https://prism.test",
      mailer,
    );
    expect(result).toEqual({ requested: true, emailed: true });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(rpcCalls[0].args).toEqual({ p_guardian_email: "Parent@Example.test " });
    expect(sendGuardianConsent).toHaveBeenCalledWith({
      to: "parent@example.test",
      childName: "Maya",
      link: `https://prism.test/consent/${TOKEN}`,
    });
  });

  it("still succeeds if the email cannot be sent, so the request is not lost", async () => {
    const { client } = recordingClient({ rpc: { request_guardian_consent: { data: TOKEN } } });
    const mailer: Mailer = {
      sendInvitation: async () => ({ sent: false }),
      sendGuardianConsent: async () => {
        throw new Error("smtp down");
      },
    };
    expect(
      await requestGuardianConsent(
        client,
        { guardianEmail: "p@example.test" },
        "Maya",
        "https://p.test",
        mailer,
      ),
    ).toEqual({ requested: true, emailed: false });
  });

  it("does not log the address or the link with the default mailer", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = recordingClient({ rpc: { request_guardian_consent: { data: TOKEN } } });
    await requestGuardianConsent(
      client,
      { guardianEmail: "secret.parent@example.test" },
      "Maya",
      "https://p.test",
    );
    const written = JSON.stringify([...info.mock.calls, ...log.mock.calls]);
    expect(written).not.toContain("secret.parent");
    expect(written).not.toContain(TOKEN);
  });

  it("says plainly when the account does not need it", async () => {
    const { client } = recordingClient({
      rpc: { request_guardian_consent: { error: { code: "P0001", message: "x" } } },
    });
    await expect(
      requestGuardianConsent(client, { guardianEmail: "p@example.test" }, "Maya", "https://p.test"),
    ).rejects.toMatchObject({ status: 409, code: "not_needed" });
  });

  it("checks the address", () => {
    expect(GuardianRequest.safeParse({ guardianEmail: "nope" }).success).toBe(false);
    expect(GuardianRequest.safeParse({ guardianEmail: " " }).success).toBe(false);
    expect(GuardianRequest.parse({ guardianEmail: " p@example.test " }).guardianEmail).toBe(
      "p@example.test",
    );
  });
});

describe("grantGuardianConsent, recordSchoolConsent and listPendingConsents", () => {
  it("passes the token to the database function", async () => {
    const { client, rpcCalls } = recordingClient({
      rpc: { grant_guardian_consent: { data: USER } },
    });
    await grantGuardianConsent(client, TOKEN);
    expect(rpcCalls[0]).toEqual({ name: "grant_guardian_consent", args: { p_token: TOKEN } });
  });

  it("says an old or used link is gone", async () => {
    const { client } = recordingClient({
      rpc: { grant_guardian_consent: { error: { code: "P0002", message: "x" } } },
    });
    await expect(grantGuardianConsent(client, TOKEN)).rejects.toMatchObject({
      status: 410,
      code: "link_invalid",
    });
  });

  it("records school consent, and maps refusals", async () => {
    const ok = recordingClient({ rpc: { record_school_consent: { data: null } } });
    await recordSchoolConsent(ok.client, STUDENT);
    expect(ok.rpcCalls[0].args).toEqual({ p_student: STUDENT });
    const refused = recordingClient({
      rpc: { record_school_consent: { error: { code: "42501", message: "x" } } },
    });
    await expect(recordSchoolConsent(refused.client, STUDENT)).rejects.toMatchObject({
      status: 404,
    });
    const notNeeded = recordingClient({
      rpc: { record_school_consent: { error: { code: "P0001", message: "x" } } },
    });
    await expect(recordSchoolConsent(notNeeded.client, STUDENT)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("lists the students waiting in a class", async () => {
    const { client } = recordingClient({
      rpc: { pending_consents: { data: [{ student_id: STUDENT }] } },
    });
    expect([...(await listPendingConsents(client, "c1"))]).toEqual([STUDENT]);
  });
});

describe("exportMyData", () => {
  const events = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `e${i}`, type: "concept_viewed" }));

  it("gathers the learner's own records from their own session, and records the export", async () => {
    const user = recordingClient({
      tables: {
        users_public: { data: [{ display_name: "Maya", is_creator: false, created_at: "x" }] },
        render_profiles: { data: [{ profile: { layout: "cards" }, share_with_teachers: false }] },
        user_consents: { data: [{ status: "granted", requested_at: null }] },
        enrollments: { data: [{ classroom_id: "c1", created_at: "x" }] },
        concept_mastery: { data: [{ concept_id: "c_1", status: "mastered" }] },
        learning_events: { data: events(3) },
        data_requests: { data: [] },
      },
    });
    const admin = recordingClient({ tables: { data_requests: { data: [] } } });
    const data = await exportMyData(
      user.client,
      admin.client,
      USER,
      new Date("2026-10-07T10:00:00Z"),
    );
    expect(data).toMatchObject({
      version: 1,
      exportedAt: "2026-10-07T10:00:00.000Z",
      account: { display_name: "Maya" },
      settings: { share_with_teachers: false },
      consent: { status: "granted" },
    });
    expect(data.events).toHaveLength(3);
    expect(data.classes).toHaveLength(1);
    const insert = opsNamed(callsOn(admin.calls, "data_requests")[0], "insert")[0][0];
    expect(insert).toMatchObject({ user_id: USER, kind: "export", status: "completed" });
    // Every read is for this person.
    for (const table of [
      "users_public",
      "render_profiles",
      "user_consents",
      "enrollments",
      "concept_mastery",
      "learning_events",
      "data_requests",
    ]) {
      const eq = opsNamed(callsOn(user.calls, table)[0], "eq")[0];
      expect(eq[1]).toBe(USER);
    }
  });

  it("holds no date of birth, guardian address or token, and no one else's data", async () => {
    const user = recordingClient({ tables: { user_consents: { data: [] } } });
    await exportMyData(user.client, recordingClient().client, USER);
    for (const call of user.calls) {
      for (const [, args] of call.ops.filter(([op]) => op === "select")) {
        expect(String(args[0])).not.toMatch(/birth_date|guardian_email|token/);
      }
    }
  });

  it("reads more than one page of events", async () => {
    const user = recordingClient({
      tables: { learning_events: [{ data: events(1000) }, { data: events(250) }] },
    });
    const data = await exportMyData(user.client, recordingClient().client, USER);
    expect(data.events).toHaveLength(1250);
    const ranges = callsOn(user.calls, "learning_events").map((c) => opsNamed(c, "range")[0]);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("still gives the person their data if recording the export fails", async () => {
    const admin = recordingClient({ tables: { data_requests: { error: { message: "down" } } } });
    const data = await exportMyData(recordingClient().client, admin.client, USER);
    expect(data.version).toBe(1);
  });

  it("says plainly when a read fails, without the database message", async () => {
    const user = recordingClient({
      tables: { users_public: { error: { message: "secret detail" } } },
    });
    const error = await exportMyData(user.client, recordingClient().client, USER).catch((e) => e);
    expect(error).toMatchObject({ status: 500, code: "export_failed" });
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("requestDeletion and loadDeletionState", () => {
  it("records the request and reports when it was made", async () => {
    const { client, calls } = recordingClient({
      tables: { data_requests: { data: [{ created_at: "2026-10-07T10:00:00Z" }] } },
    });
    expect(await requestDeletion(client, USER)).toEqual({ requestedAt: "2026-10-07T10:00:00Z" });
    expect(opsNamed(callsOn(calls, "data_requests")[0], "insert")[0][0]).toEqual({
      user_id: USER,
      kind: "delete",
    });
  });

  it("treats asking twice as harmless", async () => {
    const { client } = recordingClient({
      tables: {
        data_requests: [
          { error: { code: "23505", message: "duplicate" } },
          { data: [{ created_at: "x" }] },
        ],
      },
    });
    expect(await requestDeletion(client, USER)).toEqual({ requestedAt: "x" });
  });

  it("reports no request when there is none", async () => {
    const { client } = recordingClient({ tables: { data_requests: { data: [] } } });
    expect(await loadDeletionState(client, USER)).toEqual({ requestedAt: null });
  });
});

describe("consent and account routes", () => {
  const call = async (
    module: string,
    method: "GET" | "POST",
    body?: unknown,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) => {
    const route = await import(/* @vite-ignore */ module);
    const request = new NextRequest("http://localhost/api/x", {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return route[method](request, extra);
  };

  it("guardian request: needs a user, takes an address, and never returns the token", async () => {
    expect(
      (await call("@/app/api/consent/request/route", "POST", { guardianEmail: "p@example.test" }))
        .status,
    ).toBe(401);
    mocks.userId = USER;
    mocks.client = recordingClient({ rpc: { request_guardian_consent: { data: TOKEN } } }).client;
    const ok = await call("@/app/api/consent/request/route", "POST", {
      guardianEmail: "p@example.test",
    });
    expect(ok.status).toBe(200);
    const body = await ok.text();
    expect(JSON.parse(body)).toEqual({ requested: true });
    expect(body).not.toContain(TOKEN);
    expect(
      (await call("@/app/api/consent/request/route", "POST", { guardianEmail: "nope" })).status,
    ).toBe(400);
  });

  it("guardian grant: needs no sign-in, says a bad link is gone, and limits attempts", async () => {
    mocks.admin = recordingClient({ rpc: { grant_guardian_consent: { data: USER } } }).client;
    const ok = await call(
      "@/app/api/consent/grant/route",
      "POST",
      { token: TOKEN },
      {},
      { "x-forwarded-for": "9.9.9.1" },
    );
    expect(await ok.json()).toEqual({ granted: true });
    mocks.admin = recordingClient({
      rpc: { grant_guardian_consent: { error: { code: "P0002", message: "x" } } },
    }).client;
    const gone = await call(
      "@/app/api/consent/grant/route",
      "POST",
      { token: TOKEN },
      {},
      { "x-forwarded-for": "9.9.9.2" },
    );
    expect(gone.status).toBe(410);
    expect((await call("@/app/api/consent/grant/route", "POST", { token: "short" })).status).toBe(
      400,
    );
    let last = 200;
    for (let i = 0; i < 25; i++) {
      last = (
        await call(
          "@/app/api/consent/grant/route",
          "POST",
          { token: TOKEN },
          {},
          { "x-forwarded-for": "9.9.9.3" },
        )
      ).status;
    }
    expect(last).toBe(429);
  });

  it("school consent: needs a user and a real id, and records it", async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    expect(
      (await call("@/app/api/students/[id]/consent/route", "POST", {}, ctx(STUDENT))).status,
    ).toBe(401);
    mocks.userId = USER;
    mocks.client = recordingClient({ rpc: { record_school_consent: { data: null } } }).client;
    expect(
      (await call("@/app/api/students/[id]/consent/route", "POST", {}, ctx(STUDENT))).status,
    ).toBe(200);
    expect(
      (await call("@/app/api/students/[id]/consent/route", "POST", {}, ctx("nope"))).status,
    ).toBe(404);
  });

  it("account export: needs a user and downloads the data as a JSON file", async () => {
    expect((await call("@/app/api/account/export/route", "GET")).status).toBe(401);
    mocks.userId = USER;
    mocks.client = recordingClient({
      tables: { users_public: { data: [{ display_name: "Maya" }] } },
    }).client;
    mocks.admin = recordingClient().client;
    const response = await call("@/app/api/account/export/route", "GET");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="prism-my-data-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.parse(await response.text()).version).toBe(1);
  });

  it("account deletion: needs a user and records the request", async () => {
    expect((await call("@/app/api/account/deletion/route", "POST")).status).toBe(401);
    mocks.userId = USER;
    mocks.client = recordingClient({
      tables: { data_requests: { data: [{ created_at: "x" }] } },
    }).client;
    const response = await call("@/app/api/account/deletion/route", "POST");
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ requestedAt: "x" });
  });
});

describe("ConsentPending", () => {
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("has no accessibility violations before or after a request", async () => {
    const first = render(<ConsentPending requested={false} />);
    await expectNoAxeViolations(first.container);
    first.unmount();
    const second = render(<ConsentPending requested />);
    await expectNoAxeViolations(second.container);
  });

  it("explains in plain words that lessons are paused and what to do", () => {
    render(<ConsentPending requested={false} />);
    expect(
      screen.getByRole("heading", { name: "A parent or guardian needs to say yes first" }),
    ).toBeTruthy();
    expect(screen.getByText(/Nothing you have done has been lost/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks for an address before sending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<ConsentPending requested={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Ask my parent or guardian" }));
    expect(screen.getByText("Enter your parent or guardian's email address.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the request, says it is waiting, and never shows a link", async () => {
    answer({ requested: true });
    const { container } = render(<ConsentPending requested={false} />);
    await userEvent.type(
      screen.getByLabelText("Your parent or guardian's email"),
      "p@example.test",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask my parent or guardian" }));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /We have asked your parent or guardian/,
    );
    expect(container.textContent).not.toMatch(/\/consent\//);
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows the waiting state at once when a request was already made", () => {
    render(<ConsentPending requested />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ask again" })).toBeTruthy();
  });

  it("shows why a request failed", async () => {
    answer({ error: { code: "rate_limited", message: "Too many requests." } }, 429);
    render(<ConsentPending requested={false} />);
    await userEvent.type(
      screen.getByLabelText("Your parent or guardian's email"),
      "p@example.test",
    );
    await userEvent.click(screen.getByRole("button", { name: "Ask my parent or guardian" }));
    expect(await screen.findByText("Too many requests.")).toBeTruthy();
  });
});

describe("GuardianConsent", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(<GuardianConsent token={TOKEN} />);
    await expectNoAxeViolations(container);
  });

  it("records the agreement and thanks the guardian", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ granted: true })));
    vi.stubGlobal("fetch", fetchSpy);
    render(<GuardianConsent token={TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: /I agree/ }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Thank you/);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/consent/grant");
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
  });

  it("says plainly that doing nothing changes nothing", () => {
    render(<GuardianConsent token={TOKEN} />);
    expect(screen.getByText(/Nothing will change/)).toBeTruthy();
  });

  it("explains an expired link and lets the guardian try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "link_invalid", message: "This link has expired." } }),
            { status: 410 },
          ),
      ),
    );
    render(<GuardianConsent token={TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: /I agree/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("This link has expired.");
    expect((screen.getByRole("button", { name: /I agree/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("AccountActions", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(<AccountActions deletionRequestedOn={null} />);
    await expectNoAxeViolations(container);
  });

  it("offers a download of the data as a file", () => {
    render(<AccountActions deletionRequestedOn={null} />);
    const link = screen.getByRole("link", { name: "Download my data" });
    expect(link.getAttribute("href")).toBe("/api/account/export");
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("asks before requesting deletion, then says it is recorded", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ requestedAt: "2026-10-07T10:00:00Z" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<AccountActions deletionRequestedOn={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Ask for my account to be deleted" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Ask for deletion" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/within 30 days/);
    expect(screen.queryByRole("button", { name: "Ask for my account to be deleted" })).toBeNull();
  });

  it("shows an earlier request instead of the button", () => {
    render(<AccountActions deletionRequestedOn="2026-10-01T10:00:00Z" />);
    expect(screen.getByRole("status").textContent).toMatch(/You asked/);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows why a request failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "x", message: "Could not record it." } }), {
            status: 500,
          }),
      ),
    );
    render(<AccountActions deletionRequestedOn={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Ask for my account to be deleted" }));
    await userEvent.click(await screen.findByRole("button", { name: "Ask for deletion" }));
    expect(await screen.findByText("Could not record it.")).toBeTruthy();
  });
});

describe("RecordConsent", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(<RecordConsent studentId={STUDENT} name="Maya" />);
    await expectNoAxeViolations(container);
  });

  it("asks the teacher to confirm, says it is recorded with their name, then records and refreshes", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ recorded: true })));
    vi.stubGlobal("fetch", fetchSpy);
    render(<RecordConsent studentId={STUDENT} name="Maya" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Record that the school holds consent" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/It is recorded with your name/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Record consent" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const [url] = fetchSpy.mock.calls[0] as unknown as [string];
    expect(url).toBe(`/api/students/${STUDENT}/consent`);
  });

  it("shows a refusal and does not refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "not_found", message: "Student not found." } }),
            { status: 404 },
          ),
      ),
    );
    render(<RecordConsent studentId={STUDENT} name="Maya" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Record that the school holds consent" }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Record consent" }));
    expect(await screen.findByText("Student not found.")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
