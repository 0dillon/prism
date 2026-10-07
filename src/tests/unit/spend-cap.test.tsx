// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendCard } from "@/app/admin/SpendCard";
import { createLesson, startIngestion } from "@/lib/lessons/service";
import {
  SPEND_ALERT_RATIO,
  assertIngestionAllowed,
  formatUsd,
  loadOrgSpend,
  setSpendCap,
  spendLevel,
  spendRatio,
} from "@/lib/orgs/spend";
import { expectNoAxeViolations } from "../a11y";
import { FakeSupabase } from "../fixtures/fake-supabase";
import { opsNamed, callsOn, recordingClient } from "../fixtures/recording-supabase";

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

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.refresh.mockReset();
  mocks.userId = null;
  mocks.client = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("spend levels", () => {
  const level = (capUsd: number | null, spentUsd: number) => spendLevel({ capUsd, spentUsd });

  it("have no level without a cap", () => {
    expect(level(null, 9999)).toBe("none");
    expect(spendRatio({ capUsd: null, spentUsd: 5 })).toBeNull();
  });

  it("warn from 80% and block from 100%", () => {
    expect(SPEND_ALERT_RATIO).toBe(0.8);
    expect(level(100, 79.99)).toBe("ok");
    expect(level(100, 80)).toBe("warning");
    expect(level(100, 99.99)).toBe("warning");
    expect(level(100, 100)).toBe("blocked");
    expect(level(100, 250)).toBe("blocked");
  });

  it("treat a cap of zero as fully used, so setting it pauses everything", () => {
    expect(level(0, 0)).toBe("blocked");
    expect(spendRatio({ capUsd: 0, spentUsd: 0 })).toBe(1);
  });

  it("write dollars with cents", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});

describe("loadOrgSpend", () => {
  it("reads the cap and the month's spend, which the database sends as strings", async () => {
    const { client, rpcCalls } = recordingClient({
      rpc: { org_spend: { data: [{ cap_usd: "50.00", spent_usd: "12.345678" }] } },
    });
    expect(await loadOrgSpend(client, ORG)).toEqual({ capUsd: 50, spentUsd: 12.345678 });
    expect(rpcCalls[0]).toEqual({ name: "org_spend", args: { p_org: ORG } });
  });

  it("reads no cap as null", async () => {
    const { client } = recordingClient({
      rpc: { org_spend: { data: [{ cap_usd: null, spent_usd: "0" }] } },
    });
    expect(await loadOrgSpend(client, ORG)).toEqual({ capUsd: null, spentUsd: 0 });
  });

  it("says not found to someone who is not the principal", async () => {
    const { client } = recordingClient({
      rpc: { org_spend: { error: { code: "42501", message: "x" } } },
    });
    await expect(loadOrgSpend(client, ORG)).rejects.toMatchObject({ status: 404 });
  });
});

describe("assertIngestionAllowed", () => {
  const spend = (cap: number | null, spent: number) =>
    recordingClient({ rpc: { org_spend: { data: [{ cap_usd: cap, spent_usd: spent }] } } }).client;

  it("allows a school under its limit, or with none", async () => {
    await expect(assertIngestionAllowed(spend(50, 10), ORG)).resolves.toBeUndefined();
    await expect(assertIngestionAllowed(spend(null, 1000), ORG)).resolves.toBeUndefined();
    await expect(assertIngestionAllowed(spend(50, 45), ORG)).resolves.toBeUndefined();
  });

  it("stops a school at its limit with a clear message that shows no amounts", async () => {
    const error = await assertIngestionAllowed(spend(50, 50), ORG).catch((e) => e);
    expect(error).toMatchObject({ status: 403, code: "spend_cap_reached" });
    expect(error.message).toMatch(/reached its monthly limit/);
    expect(error.message).toMatch(/ask your principal/i);
    expect(error.message).not.toMatch(/\$|\d/);
  });

  it("does not block anyone when the spend cannot be read", async () => {
    const broken = recordingClient({
      rpc: { org_spend: { error: { code: "XX000", message: "down" } } },
    }).client;
    await expect(assertIngestionAllowed(broken, ORG)).resolves.toBeUndefined();
  });
});

describe("setSpendCap", () => {
  it("saves the cap to the cent and returns the spend", async () => {
    const { client, calls } = recordingClient({
      tables: { organizations: { data: [{ id: ORG }] } },
      rpc: { org_spend: { data: [{ cap_usd: "12.35", spent_usd: "1" }] } },
    });
    expect(await setSpendCap(client, ORG, 12.3456)).toEqual({ capUsd: 12.35, spentUsd: 1 });
    expect(opsNamed(callsOn(calls, "organizations")[0], "update")[0][0]).toEqual({
      monthly_spend_cap_usd: 12.35,
    });
  });

  it("removes the cap with null", async () => {
    const { client, calls } = recordingClient({
      tables: { organizations: { data: [{ id: ORG }] } },
    });
    await setSpendCap(client, ORG, null);
    expect(opsNamed(callsOn(calls, "organizations")[0], "update")[0][0]).toEqual({
      monthly_spend_cap_usd: null,
    });
  });

  it("is not found when no row changed, which is what a teacher's attempt looks like", async () => {
    const { client } = recordingClient({ tables: { organizations: { data: [] } } });
    await expect(setSpendCap(client, ORG, 5)).rejects.toMatchObject({ status: 404 });
  });
});

describe("starting an upload for a school over its limit", () => {
  let db: FakeSupabase;

  beforeEach(() => {
    db = new FakeSupabase();
    db.tables.org_memberships.push({
      org_id: ORG,
      user_id: USER,
      role: "teacher",
      created_at: "2026-01-01",
    });
  });

  const overCap = () => {
    db.rpcHandlers.org_spend = () => ({ data: [{ cap_usd: "5", spent_usd: "5.2" }], error: null });
  };
  const underCap = () => {
    db.rpcHandlers.org_spend = () => ({ data: [{ cap_usd: "5", spent_usd: "1" }], error: null });
  };
  const input = { fileName: "notes.pdf", fileSize: 1000 };
  const clients = () => ({ user: db.asUser(USER), admin: db.asAdmin() });

  it("cannot start, sees a clear message, and leaves nothing behind", async () => {
    overCap();
    const error = await createLesson(clients(), USER, input).catch((e) => e);
    expect(error).toMatchObject({ status: 403, code: "spend_cap_reached" });
    expect(error.message).toMatch(/new uploads are paused/);
    expect(db.tables.lessons).toHaveLength(0);
    expect(db.tables.ingestion_jobs).toHaveLength(0);
  });

  it("can start under the limit, and the lesson carries the school", async () => {
    underCap();
    await createLesson(clients(), USER, input);
    expect(db.tables.lessons[0].org_id).toBe(ORG);
  });

  it("can start with no limit set", async () => {
    db.rpcHandlers.org_spend = () => ({ data: [{ cap_usd: null, spent_usd: "99" }], error: null });
    await expect(createLesson(clients(), USER, input)).resolves.toBeTruthy();
  });

  it("is not limited for a teacher with no school", async () => {
    db.tables.org_memberships.length = 0;
    overCap();
    await createLesson(clients(), USER, input);
    expect(db.tables.lessons[0].org_id).toBeNull();
  });

  it("will not attach a school the teacher does not teach in", async () => {
    underCap();
    await expect(
      createLesson(clients(), USER, { ...input, orgId: "99999999-9999-4999-8999-999999999999" }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("also stops an existing lesson from being processed again while over the limit", async () => {
    underCap();
    const made = await createLesson(clients(), USER, input);
    overCap();
    await expect(startIngestion(clients(), USER, made.lessonId)).rejects.toMatchObject({
      status: 403,
      code: "spend_cap_reached",
    });
  });
});

describe("PUT /api/orgs/[id]/spend-cap", () => {
  const put = async (body: unknown, id = ORG) => {
    const { PUT } = await import("@/app/api/orgs/[id]/spend-cap/route");
    return PUT(
      new NextRequest(`http://localhost/api/orgs/${id}/spend-cap`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) } as never,
    );
  };

  it("needs a signed-in user", async () => {
    expect((await put({ capUsd: 5 })).status).toBe(401);
  });

  it("sets the limit", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient({
      tables: { organizations: { data: [{ id: ORG }] } },
      rpc: { org_spend: { data: [{ cap_usd: "5", spent_usd: "0" }] } },
    }).client;
    expect(await (await put({ capUsd: 5 })).json()).toEqual({ capUsd: 5, spentUsd: 0 });
  });

  it("refuses a negative, huge or non-numeric limit, and a bad id", async () => {
    mocks.userId = USER;
    mocks.client = recordingClient().client;
    expect((await put({ capUsd: -1 })).status).toBe(400);
    expect((await put({ capUsd: 1e9 })).status).toBe(400);
    expect((await put({ capUsd: "lots" })).status).toBe(400);
    expect((await put({ capUsd: 5 }, "nope")).status).toBe(404);
  });
});

describe("SpendCard", () => {
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("has no accessibility violations in any state", async () => {
    for (const spend of [
      { capUsd: null, spentUsd: 3 },
      { capUsd: 100, spentUsd: 10 },
      { capUsd: 100, spentUsd: 85 },
      { capUsd: 100, spentUsd: 100 },
    ]) {
      const { container, unmount } = render(<SpendCard orgId={ORG} spend={spend} />);
      await expectNoAxeViolations(container);
      unmount();
    }
  });

  it("says there is no limit, and shows no bar", () => {
    render(<SpendCard orgId={ORG} spend={{ capUsd: null, spentUsd: 3.5 }} />);
    expect(screen.getByText(/There is no limit set/)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows no alert under 80%", () => {
    render(<SpendCard orgId={ORG} spend={{ capUsd: 100, spentUsd: 50 }} />);
    expect(
      screen.getByRole("progressbar", { name: "Share of the monthly limit used" }),
    ).toBeTruthy();
    expect(screen.getByText("50% used")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns at 80% in words, politely", () => {
    render(<SpendCard orgId={ORG} spend={{ capUsd: 100, spentUsd: 82 }} />);
    expect(screen.getByRole("status").textContent).toMatch(/used 82% of this month.s limit/);
  });

  it("says plainly at 100% that new uploads are paused, as an alert", () => {
    render(<SpendCard orgId={ORG} spend={{ capUsd: 100, spentUsd: 100 }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/cannot start new uploads/);
    expect(screen.getByText("100% used")).toBeTruthy();
  });

  it("saves a new limit with a PUT and refreshes", async () => {
    answer({ capUsd: 75, spentUsd: 0 });
    render(<SpendCard orgId={ORG} spend={{ capUsd: 50, spentUsd: 0 }} />);
    const field = screen.getByLabelText("Monthly limit in dollars");
    await userEvent.clear(field);
    await userEvent.type(field, "75");
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/orgs/${ORG}/spend-cap`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ capUsd: 75 });
  });

  it("removes the limit when the field is emptied", async () => {
    answer({ capUsd: null, spentUsd: 0 });
    render(<SpendCard orgId={ORG} spend={{ capUsd: 50, spentUsd: 0 }} />);
    await userEvent.clear(screen.getByLabelText("Monthly limit in dollars"));
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    const [, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ capUsd: null });
  });

  it("shows the server's message when saving fails", async () => {
    answer({ error: { code: "not_found", message: "School not found." } }, 404);
    render(<SpendCard orgId={ORG} spend={{ capUsd: 50, spentUsd: 0 }} />);
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(await screen.findByText("School not found.")).toBeTruthy();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
