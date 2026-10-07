// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteForm } from "@/app/admin/InviteForm";
import { AcceptInvite } from "@/app/invite/[token]/AcceptInvite";
import type { UserClient } from "@/lib/api/http";
import { logMailer, type Mailer } from "@/lib/orgs/mailer";
import { acceptInvitation, inviteToOrg } from "@/lib/orgs/service";
import { expectNoAxeViolations } from "../a11y";

const mocks = vi.hoisted(() => ({ push: vi.fn(), userId: null as string | null, rpc: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        mocks.userId ? { data: { user: { id: mocks.userId } } } : { data: { user: null } },
    },
    rpc: mocks.rpc,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: "Oak" } }) }) }),
    }),
  }),
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const TOKEN = "a".repeat(64);

function client(rpc: unknown) {
  return {
    rpc,
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: { name: "Oak School" } }) }),
      }),
    }),
  } as unknown as UserClient;
}

const created = {
  data: [{ invitation_id: "i1", token: TOKEN, expires_at: "2026-10-14T10:00:00Z" }],
  error: null,
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.push.mockReset();
  mocks.rpc.mockReset();
  mocks.userId = null;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inviteToOrg", () => {
  it("returns a link on this site with the token, and says whether it was emailed", async () => {
    const result = await inviteToOrg(
      client(vi.fn(async () => created)),
      ORG,
      { email: "T@School.test", role: "teacher" },
      "https://prism.test",
    );
    expect(result).toEqual({
      invitationId: "i1",
      email: "t@school.test",
      role: "teacher",
      expiresAt: "2026-10-14T10:00:00Z",
      link: `https://prism.test/invite/${TOKEN}`,
      emailed: false,
    });
  });

  it("hands the mailer the school's name and the link", async () => {
    const sendInvitation = vi.fn(async () => ({ sent: true }));
    const mailer: Mailer = { sendInvitation, sendGuardianConsent: async () => ({ sent: false }) };
    const result = await inviteToOrg(
      client(vi.fn(async () => created)),
      ORG,
      { email: "t@school.test", role: "principal" },
      "https://prism.test",
      mailer,
    );
    expect(result.emailed).toBe(true);
    expect(sendInvitation).toHaveBeenCalledWith({
      to: "t@school.test",
      orgName: "Oak School",
      role: "principal",
      link: `https://prism.test/invite/${TOKEN}`,
    });
  });

  it("still returns the link if the mailer fails", async () => {
    const mailer: Mailer = {
      sendInvitation: async () => {
        throw new Error("smtp down");
      },
      sendGuardianConsent: async () => ({ sent: false }),
    };
    const result = await inviteToOrg(
      client(vi.fn(async () => created)),
      ORG,
      { email: "t@school.test", role: "teacher" },
      "https://prism.test",
      mailer,
    );
    expect(result.emailed).toBe(false);
    expect(result.link).toContain(TOKEN);
  });

  it("never writes the token to the log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await logMailer.sendInvitation({
      to: "t@school.test",
      orgName: "Oak",
      role: "teacher",
      link: `https://prism.test/invite/${TOKEN}`,
    });
    const written = JSON.stringify([...info.mock.calls, ...log.mock.calls]);
    expect(written).not.toContain(TOKEN);
  });

  it("explains that only the principal can invite", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "x" } }));
    await expect(
      inviteToOrg(client(rpc), ORG, { email: "t@school.test", role: "teacher" }, "https://p.test"),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("acceptInvitation", () => {
  it("returns the organization and role joined", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ joined_org: ORG, joined_role: "teacher" }],
      error: null,
    }));
    expect(await acceptInvitation(client(rpc), TOKEN)).toEqual({ orgId: ORG, role: "teacher" });
    expect(rpc).toHaveBeenCalledWith("accept_invitation", { p_token: TOKEN });
  });

  it("says an expired or used invitation is gone", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0002", message: "x" } }));
    await expect(acceptInvitation(client(rpc), TOKEN)).rejects.toMatchObject({
      status: 410,
      code: "invitation_invalid",
    });
  });

  it("tells someone on the wrong account to use the invited address", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "x" } }));
    const error = await acceptInvitation(client(rpc), TOKEN).catch((e) => e);
    expect(error).toMatchObject({ status: 403, code: "wrong_account" });
    expect(error.message).toMatch(/different email/);
  });
});

describe("invitation routes", () => {
  const invite = async (body: unknown, id = ORG) => {
    const { POST } = await import("@/app/api/orgs/[id]/invites/route");
    return POST(
      new NextRequest(`http://localhost/api/orgs/${id}/invites`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) } as never,
    );
  };
  const accept = async (body: unknown) => {
    const { POST } = await import("@/app/api/invites/accept/route");
    return POST(
      new NextRequest("http://localhost/api/invites/accept", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  };

  it("need a signed-in user", async () => {
    expect((await invite({ email: "a@b.test" })).status).toBe(401);
    expect((await accept({ token: TOKEN })).status).toBe(401);
  });

  it("create an invitation with the origin of the request in the link", async () => {
    mocks.userId = "u1";
    mocks.rpc.mockResolvedValue(created);
    const response = await invite({ email: "t@school.test" });
    expect(response.status).toBe(201);
    expect((await response.json()).link).toBe(`http://localhost/invite/${TOKEN}`);
    expect(mocks.rpc).toHaveBeenCalledWith("create_invitation", {
      p_org: ORG,
      p_email: "t@school.test",
      p_role: "teacher",
    });
  });

  it("reject a bad email, a bad role and a bad organization id", async () => {
    mocks.userId = "u1";
    expect((await invite({ email: "nope" })).status).toBe(400);
    expect((await invite({ email: "a@b.test", role: "student" })).status).toBe(400);
    expect((await invite({ email: "a@b.test" }, "not-a-uuid")).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accept passes the token to the database function", async () => {
    mocks.userId = "u1";
    mocks.rpc.mockResolvedValue({
      data: [{ joined_org: ORG, joined_role: "teacher" }],
      error: null,
    });
    const response = await accept({ token: TOKEN });
    expect(await response.json()).toEqual({ orgId: ORG, role: "teacher" });
    expect((await accept({ token: "short" })).status).toBe(400);
  });
});

describe("InviteForm", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(<InviteForm orgId={ORG} />);
    await expectNoAxeViolations(container);
  });

  it("asks for an address before sending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<InviteForm orgId={ORG} />);
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(screen.getByText("Enter an email address.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows the link to share once the invitation exists", async () => {
    const invite = {
      invitationId: "i1",
      email: "t@school.test",
      role: "teacher",
      expiresAt: "2026-10-14T10:00:00Z",
      link: `https://prism.test/invite/${TOKEN}`,
      emailed: false,
    };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(invite), { status: 201 }));
    vi.stubGlobal("fetch", fetchSpy);
    render(<InviteForm orgId={ORG} />);
    await userEvent.type(screen.getByLabelText("Email address"), "t@school.test");
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const link = (await screen.findByLabelText(
      "Invitation link for t@school.test",
    )) as HTMLInputElement;
    expect(link.value).toBe(invite.link);
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/orgs/${ORG}/invites`,
      expect.objectContaining({ method: "POST" }),
    );
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe("");
  });

  it("shows why it failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "forbidden", message: "Only the principal can invite people." },
            }),
            {
              status: 403,
            },
          ),
      ),
    );
    render(<InviteForm orgId={ORG} />);
    await userEvent.type(screen.getByLabelText("Email address"), "t@school.test");
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByText("Only the principal can invite people.")).toBeTruthy();
  });
});

describe("AcceptInvite", () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status })),
    );

  it("sends a teacher to their classes after joining", async () => {
    respond(200, { orgId: ORG, role: "teacher" });
    render(<AcceptInvite token={TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/teach/classrooms"));
  });

  it("sends a principal to the school page", async () => {
    respond(200, { orgId: ORG, role: "principal" });
    render(<AcceptInvite token={TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin"));
  });

  it("explains an expired invitation and stays put", async () => {
    respond(410, {
      error: { code: "invitation_invalid", message: "This invitation has expired." },
    });
    render(<AcceptInvite token={TOKEN} />);
    await userEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This invitation has expired.",
    );
    expect(mocks.push).not.toHaveBeenCalled();
  });
});
