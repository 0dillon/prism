import { describe, expect, it } from "vitest";
import {
  decideAccess,
  isAuthPage,
  isProtectedPath,
  safeNextPath,
  signInPathFor,
} from "@/lib/auth/paths";

describe("isProtectedPath", () => {
  it.each(["/learn", "/learn/abc", "/teach", "/teach/lessons/1/review", "/admin", "/create/x"])(
    "protects %s",
    (path) => {
      expect(isProtectedPath(path)).toBe(true);
    },
  );

  it.each(["/", "/sign-in", "/onboarding", "/market", "/market/course", "/api/events", "/learner"])(
    "leaves %s public",
    (path) => {
      expect(isProtectedPath(path)).toBe(false);
    },
  );

  it("does not match a path that merely starts with a protected word", () => {
    expect(isProtectedPath("/learning")).toBe(false);
    expect(isProtectedPath("/teacher")).toBe(false);
    expect(isProtectedPath("/administrator")).toBe(false);
    expect(isProtectedPath("/creator")).toBe(false);
  });
});

describe("isAuthPage", () => {
  it("matches the sign-in and sign-up pages", () => {
    expect(isAuthPage("/sign-in")).toBe(true);
    expect(isAuthPage("/sign-up")).toBe(true);
    expect(isAuthPage("/sign-up/")).toBe(true);
    expect(isAuthPage("/sign-out")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps on-site paths, including query strings", () => {
    expect(safeNextPath("/teach/lessons/1?tab=signs")).toBe("/teach/lessons/1?tab=signs");
  });

  it.each([
    null,
    undefined,
    "",
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "javascript:alert(1)",
    "learn",
    "/\u0009/evil.test",
  ])("falls back to the learner home for %j", (next) => {
    expect(safeNextPath(next)).toBe("/learn");
  });
});

describe("signInPathFor", () => {
  it("encodes the destination", () => {
    expect(signInPathFor("/learn/abc?x=1&y=2")).toBe(
      "/sign-in?next=%2Flearn%2Fabc%3Fx%3D1%26y%3D2",
    );
  });
});

describe("decideAccess", () => {
  it.each(["/learn", "/teach", "/admin", "/create"])(
    "redirects a signed-out visitor from %s to sign in",
    (pathname) => {
      expect(decideAccess({ pathname, isSignedIn: false })).toEqual({
        action: "redirect",
        location: `/sign-in?next=${encodeURIComponent(pathname)}`,
      });
    },
  );

  it("keeps the query string in the return path", () => {
    expect(decideAccess({ pathname: "/learn/x", search: "?a=1", isSignedIn: false })).toEqual({
      action: "redirect",
      location: "/sign-in?next=%2Flearn%2Fx%3Fa%3D1",
    });
  });

  it("allows a signed-in visitor into protected areas", () => {
    expect(decideAccess({ pathname: "/teach/upload", isSignedIn: true })).toEqual({
      action: "allow",
    });
  });

  it("allows signed-out visitors on public pages", () => {
    expect(decideAccess({ pathname: "/", isSignedIn: false })).toEqual({ action: "allow" });
    expect(decideAccess({ pathname: "/sign-in", isSignedIn: false })).toEqual({ action: "allow" });
  });

  it("sends a signed-in visitor away from the sign-in and sign-up pages", () => {
    expect(decideAccess({ pathname: "/sign-in", isSignedIn: true })).toEqual({
      action: "redirect",
      location: "/learn",
    });
    expect(decideAccess({ pathname: "/sign-up", isSignedIn: true })).toEqual({
      action: "redirect",
      location: "/learn",
    });
  });
});
