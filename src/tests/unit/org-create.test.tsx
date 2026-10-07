// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupForm } from "@/app/admin/setup/SetupForm";
import type { UserClient } from "@/lib/api/http";
import { createOrganization, slugify } from "@/lib/orgs/service";
import { expectNoAxeViolations } from "../a11y";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  userId: null as string | null,
  rpc: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        mocks.userId ? { data: { user: { id: mocks.userId } } } : { data: { user: null } },
    },
    rpc: mocks.rpc,
  }),
}));

const client = (rpc: unknown) => ({ rpc }) as unknown as UserClient;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.push.mockReset();
  mocks.rpc.mockReset();
  mocks.userId = null;
});
afterEach(() => vi.restoreAllMocks());

describe("slugify", () => {
  it("lowercases, strips accents and joins words with hyphens", () => {
    expect(slugify("  Écoles de l'Avenir! ")).toBe("ecoles-de-l-avenir");
  });

  it("falls back to a word when nothing usable is left", () => {
    expect(slugify("!!!")).toBe("school");
  });

  it("keeps the slug short and never ends it with a hyphen", () => {
    const slug = slugify("a".repeat(47) + " " + "b".repeat(20));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("createOrganization", () => {
  it("returns the new id and the slug it used", async () => {
    const rpc = vi.fn(async () => ({ data: "org-1", error: null }));
    expect(await createOrganization(client(rpc), "Oak School")).toEqual({
      id: "org-1",
      slug: "oak-school",
    });
    expect(rpc).toHaveBeenCalledWith("create_organization", {
      p_name: "Oak School",
      p_slug: "oak-school",
    });
  });

  it("tries a different slug when the first is taken", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate" } })
      .mockResolvedValueOnce({ data: "org-2", error: null });
    const result = await createOrganization(client(rpc), "Oak School");
    expect(result.id).toBe("org-2");
    expect(result.slug).toMatch(/^oak-school-[0-9a-f]{4}$/);
  });

  it("gives up with a clear message after repeated clashes", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "23505", message: "duplicate" } }));
    await expect(createOrganization(client(rpc), "Oak")).rejects.toMatchObject({
      status: 409,
      code: "name_taken",
    });
    expect(rpc).toHaveBeenCalledTimes(5);
  });

  it("reports any other failure without exposing the database message", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "XX000", message: "secret detail" },
    }));
    const error = await createOrganization(client(rpc), "Oak").catch((e) => e);
    expect(error).toMatchObject({ status: 500, code: "create_failed" });
    expect(error.message).not.toMatch(/secret/);
  });
});

describe("POST /api/orgs", () => {
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/orgs/route");
    return POST(
      new NextRequest("http://localhost/api/orgs", { method: "POST", body: JSON.stringify(body) }),
    );
  };

  it("needs a signed-in user", async () => {
    expect((await post({ name: "Oak" })).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("creates the organization for the signed-in user", async () => {
    mocks.userId = "u1";
    mocks.rpc.mockResolvedValue({ data: "org-1", error: null });
    const response = await post({ name: " Oak School " });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "org-1", slug: "oak-school" });
    expect(mocks.rpc).toHaveBeenCalledWith("create_organization", {
      p_name: "Oak School",
      p_slug: "oak-school",
    });
  });

  it("rejects a missing or empty name", async () => {
    mocks.userId = "u1";
    expect((await post({ name: "   " })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("SetupForm", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has no accessibility violations", async () => {
    const { container } = render(<SetupForm />);
    await expectNoAxeViolations(container);
  });

  it("asks for a name instead of sending an empty form", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<SetupForm />);
    await userEvent.click(screen.getByRole("button", { name: "Set up my school" }));
    expect(screen.getByText("Enter your school's name.")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText("School name"));
  });

  it("creates the school and goes to the school page", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ id: "o", slug: "oak" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    render(<SetupForm />);
    await userEvent.type(screen.getByLabelText("School name"), "Oak School");
    await userEvent.click(screen.getByRole("button", { name: "Set up my school" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/admin"));
    expect(
      JSON.parse((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string),
    ).toEqual({
      name: "Oak School",
    });
  });

  it("shows the server's message and stays on the page when it fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "name_taken", message: "Name in use." } }), {
            status: 409,
          }),
      ),
    );
    render(<SetupForm />);
    await userEvent.type(screen.getByLabelText("School name"), "Oak");
    await userEvent.click(screen.getByRole("button", { name: "Set up my school" }));
    expect(await screen.findByText("Name in use.")).toBeTruthy();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Set up my school" })).toHaveProperty(
      "disabled",
      false,
    );
  });
});
