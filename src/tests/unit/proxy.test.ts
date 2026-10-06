import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getClaims = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({ auth: { getClaims } })),
}));

vi.mock("@/lib/env", () => ({
  clientEnv: () => ({
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  }),
}));

import { proxy } from "@/proxy";

const request = (path: string) => new NextRequest(`http://localhost:3000${path}`);

beforeEach(() => {
  getClaims.mockReset();
});

describe("proxy route protection", () => {
  describe("signed out", () => {
    beforeEach(() => {
      getClaims.mockResolvedValue({ data: null, error: null });
    });

    it.each(["/learn", "/teach", "/admin", "/create"])(
      "redirects %s to the sign-in page",
      async (path) => {
        const response = await proxy(request(path));
        expect(response.status).toBe(307);
        expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
        expect(new URL(response.headers.get("location")!).searchParams.get("next")).toBe(path);
      },
    );

    it("redirects nested protected paths and keeps the query", async () => {
      const response = await proxy(request("/teach/lessons/42/review?tab=signs"));
      const location = new URL(response.headers.get("location")!);
      expect(location.searchParams.get("next")).toBe("/teach/lessons/42/review?tab=signs");
    });

    it.each(["/", "/sign-in", "/sign-up", "/onboarding", "/market"])(
      "lets %s through",
      async (path) => {
        const response = await proxy(request(path));
        expect(response.headers.get("location")).toBeNull();
        expect(response.status).toBe(200);
      },
    );
  });

  describe("signed in", () => {
    beforeEach(() => {
      getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null });
    });

    it.each(["/learn", "/teach", "/admin", "/create"])("lets %s through", async (path) => {
      const response = await proxy(request(path));
      expect(response.headers.get("location")).toBeNull();
    });

    it("sends the sign-in page to the learner home", async () => {
      const response = await proxy(request("/sign-in"));
      expect(new URL(response.headers.get("location")!).pathname).toBe("/learn");
    });
  });

  it("treats a token with no subject as signed out", async () => {
    getClaims.mockResolvedValue({ data: { claims: {} }, error: null });
    const response = await proxy(request("/learn"));
    expect(response.status).toBe(307);
  });
});
