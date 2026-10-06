import { describe, expect, it } from "vitest";
import { fieldErrors, SignInInput, SignUpInput } from "@/lib/auth/schemas";

describe("SignInInput", () => {
  it("accepts an email and password and trims the email", () => {
    expect(SignInInput.parse({ email: "  a@example.test ", password: "x" })).toEqual({
      email: "a@example.test",
      password: "x",
    });
  });

  it("rejects a missing email, a malformed email and an empty password", () => {
    expect(SignInInput.safeParse({ email: "", password: "x" }).success).toBe(false);
    expect(SignInInput.safeParse({ email: "nope", password: "x" }).success).toBe(false);
    expect(SignInInput.safeParse({ email: "a@example.test", password: "" }).success).toBe(false);
  });
});

describe("SignUpInput", () => {
  const valid = { displayName: "Maya", email: "maya@example.test", password: "correct horse" };

  it("accepts valid input", () => {
    expect(SignUpInput.parse(valid).displayName).toBe("Maya");
  });

  it("requires a password of at least 8 characters", () => {
    const result = SignUpInput.safeParse({ ...valid, password: "short" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(fieldErrors(result.error).password).toBe(
        "Use at least 8 characters for your password.",
      );
    }
  });

  it("requires a name of 1 to 60 characters", () => {
    expect(SignUpInput.safeParse({ ...valid, displayName: "   " }).success).toBe(false);
    expect(SignUpInput.safeParse({ ...valid, displayName: "x".repeat(61) }).success).toBe(false);
  });
});

describe("fieldErrors", () => {
  it("keeps the first message per field", () => {
    const result = SignUpInput.safeParse({ displayName: "", email: "bad", password: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errors = fieldErrors(result.error);
      expect(Object.keys(errors).sort()).toEqual(["displayName", "email", "password"]);
      expect(errors.email).toBe("Enter a valid email address.");
    }
  });
});
