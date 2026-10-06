import { describe, expect, it } from "vitest";
import { EnvError, parseServerEnv } from "@/lib/env";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  LLM_PROVIDER: "anthropic",
  LLM_API_KEY: "key",
  LLM_MODEL_HEAVY: "heavy-model",
  LLM_MODEL_FAST: "fast-model",
};

describe("parseServerEnv", () => {
  it("accepts a minimal valid environment and fills defaults", () => {
    const env = parseServerEnv(valid);
    expect(env.STT_PROVIDER).toBe("browser");
    expect(env.TTS_PROVIDER).toBe("browser");
    expect(env.PLATFORM_FEE_BPS).toBe(1500);
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("lists every missing required variable in one error", () => {
    let error: unknown;
    try {
      parseServerEnv({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    for (const key of Object.keys(valid)) {
      expect(message).toContain(`${key} is required but not set`);
    }
    expect(message).toContain(".env.example");
  });

  it("treats empty strings as unset", () => {
    expect(() => parseServerEnv({ ...valid, LLM_API_KEY: "" })).toThrow(
      "LLM_API_KEY is required but not set",
    );
  });

  it.each(["anthropic", "openai", "google"])("accepts the %s LLM provider", (provider) => {
    expect(parseServerEnv({ ...valid, LLM_PROVIDER: provider }).LLM_PROVIDER).toBe(provider);
  });

  it("rejects an unknown LLM provider", () => {
    expect(() => parseServerEnv({ ...valid, LLM_PROVIDER: "nope" })).toThrow(EnvError);
  });

  it("requires an API key for non-browser speech providers", () => {
    expect(() => parseServerEnv({ ...valid, STT_PROVIDER: "deepgram" })).toThrow("STT_API_KEY");
    expect(() => parseServerEnv({ ...valid, TTS_PROVIDER: "elevenlabs" })).toThrow("TTS_API_KEY");
    expect(
      parseServerEnv({ ...valid, STT_PROVIDER: "deepgram", STT_API_KEY: "k" }).STT_PROVIDER,
    ).toBe("deepgram");
  });

  it("coerces the platform fee to an integer within basis point bounds", () => {
    expect(parseServerEnv({ ...valid, PLATFORM_FEE_BPS: "2000" }).PLATFORM_FEE_BPS).toBe(2000);
    expect(() => parseServerEnv({ ...valid, PLATFORM_FEE_BPS: "20000" })).toThrow(EnvError);
  });
});
