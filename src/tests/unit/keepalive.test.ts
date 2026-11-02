import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ result: { error: null as { message: string } | null } }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ limit: async () => mocks.result }) }),
  }),
}));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.result = { error: null };
  vi.resetModules();
});

const call = async () => {
  const { GET } = await import("@/app/api/keepalive/route");
  return GET();
};

describe("GET /api/keepalive", () => {
  it("answers ok when the database answers, and is never cached", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails loudly when the database cannot be reached, so the scheduled job shows red", async () => {
    mocks.result = { error: { message: "fetch failed" } };
    const response = await call();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it("does not say why it failed, so nothing about the setup leaks", async () => {
    mocks.result = { error: { message: "secret connection detail" } };
    const response = await call();
    expect(await response.text()).not.toContain("secret");
  });

  it("stops querying after 30 calls an hour, so it cannot be used to load the database", async () => {
    const { GET } = await import("@/app/api/keepalive/route");
    let last: unknown = null;
    for (let i = 0; i < 31; i++) last = await (await GET()).json();
    expect(last).toEqual({ ok: true, skipped: true });
  });
});
