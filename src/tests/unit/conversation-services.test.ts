import { afterEach, describe, expect, it, vi } from "vitest";
import { INTENT_TIMEOUT_MS, networkServices } from "@/renderers/conversation/services";

const context = { lessonId: "demo-water-cycle", lessonTitle: "T" };

afterEach(() => vi.unstubAllGlobals());

describe("networkServices.resolveIntent", () => {
  it("answers a local phrase without any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await networkServices.resolveIntent("next", context)).toEqual({ type: "next" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks the server for anything else, sending the lesson and a timeout", async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ intent: { type: "simplify" }, source: "model" })),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await networkServices.resolveIntent("go over that again but easier", context)).toEqual({
      type: "simplify",
    });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/session/intent");
    expect(JSON.parse(init.body as string)).toMatchObject({
      lessonId: "demo-water-cycle",
      context: { lessonTitle: "T" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("guesses when the server errors, is unreachable or is too slow", async () => {
    for (const behaviour of [
      async () => new Response("{}", { status: 500 }),
      async () => {
        throw new TypeError("offline");
      },
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn(behaviour));
      expect(await networkServices.resolveIntent("why do clouds form", context)).toEqual({
        type: "question",
        text: "why do clouds form",
      });
      expect(await networkServices.resolveIntent("hmm", context)).toEqual({ type: "unknown" });
    }
  });

  it("waits only a few seconds", () => {
    expect(INTENT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
