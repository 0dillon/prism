import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createChatModel,
  formatIssues,
  generateStructured,
  llmConfigFromEnv,
  StructuredOutputError,
  type LlmConfig,
  type StructuredCapableModel,
} from "@/lib/ai/llm";
import {
  clearModelPrices,
  estimateCostUsd,
  setModelPrice,
  UsageTracker,
  type UsageRecord,
} from "@/lib/ai/usage";
import { parseServerEnv } from "@/lib/env";

const Answer = z.object({ title: z.string().min(1), count: z.number().int().min(0).default(0) });

const config: LlmConfig = {
  provider: "google",
  apiKey: "test-key",
  models: { heavy: "heavy-model", fast: "fast-model" },
};

type Reply = { parsed?: unknown; parsingError?: unknown; usage?: [number, number] } | Error;

/** A model whose structured output runnable replays the given replies, recording what it was sent. */
function fakeModel(replies: Reply[]) {
  const calls: BaseMessage[][] = [];
  const queue = [...replies];
  const model: StructuredCapableModel = {
    withStructuredOutput: () => ({
      invoke: async (messages: BaseMessage[]) => {
        calls.push([...messages]);
        const reply = queue.shift();
        if (!reply) throw new Error("fake model ran out of replies");
        if (reply instanceof Error) throw reply;
        return {
          parsed: reply.parsed ?? null,
          parsingError: reply.parsingError ?? null,
          raw: reply.usage
            ? { usage_metadata: { input_tokens: reply.usage[0], output_tokens: reply.usage[1] } }
            : {},
        };
      },
    }),
  };
  return { model, calls };
}

const run = (
  model: StructuredCapableModel,
  extra: Partial<Parameters<typeof generateStructured>[0]> = {},
) =>
  generateStructured({
    schema: Answer,
    prompt: "Give me an answer",
    tier: "heavy",
    name: "test-task",
    config,
    model,
    ...extra,
  } as Parameters<typeof generateStructured<typeof Answer>>[0]);

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  clearModelPrices();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generateStructured", () => {
  it("returns validated output on the first attempt", async () => {
    const { model, calls } = fakeModel([{ parsed: { title: "Water" }, usage: [100, 20] }]);
    const result = await run(model);
    expect(result).toEqual({ title: "Water", count: 0 }); // the default is applied by Zod
    expect(calls).toHaveLength(1);
  });

  it("sends the system prompt first and the user prompt after it", async () => {
    const { model, calls } = fakeModel([{ parsed: { title: "x" } }]);
    await run(model, { system: "You are a tutor." });
    expect(calls[0].map((m) => [m.getType(), m.content])).toEqual([
      ["system", "You are a tutor."],
      ["human", "Give me an answer"],
    ]);
  });

  it("retries once with the validation error and then succeeds", async () => {
    const { model, calls } = fakeModel([
      { parsed: { title: "" }, usage: [100, 10] },
      { parsed: { title: "Fixed" }, usage: [150, 12] },
    ]);
    const result = await run(model);
    expect(result.title).toBe("Fixed");
    expect(calls).toHaveLength(2);
    const retryMessage = String(calls[1][calls[1].length - 1].content);
    expect(retryMessage).toContain("rejected");
    expect(retryMessage).toContain("title");
  });

  it("fails with a logged StructuredOutputError after the retry also fails", async () => {
    const { model, calls } = fakeModel([{ parsed: { title: "" } }, { parsed: { count: -1 } }]);
    const error = await run(model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect((error as StructuredOutputError).attempts).toBe(2);
    expect((error as StructuredOutputError).task).toBe("test-task");
    expect(calls).toHaveLength(2); // exactly one retry, never more
    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(vi.mocked(console.error).mock.calls[0][0] as string);
    expect(logged).toMatchObject({ level: "error", task: "test-task", attempts: 2 });
  });

  it("treats a missing structured output as a validation failure", async () => {
    const { model } = fakeModel([
      { parsed: null, parsingError: new Error("not json") },
      { parsed: { title: "Recovered" } },
    ]);
    await expect(run(model)).resolves.toMatchObject({ title: "Recovered" });
  });

  it("treats a thrown parser exception as a validation failure", async () => {
    const parseError = Object.assign(new Error("Failed to parse"), {
      name: "OutputParserException",
    });
    const { model } = fakeModel([parseError, { parsed: { title: "Ok" } }]);
    await expect(run(model)).resolves.toMatchObject({ title: "Ok" });
  });

  it("does not retry transport or authentication errors", async () => {
    const { model, calls } = fakeModel([new Error("401 invalid API key")]);
    await expect(run(model)).rejects.toThrow("401 invalid API key");
    expect(calls).toHaveLength(1);
  });

  it("applies refinements, not only the JSON schema", async () => {
    const Refined = z.object({ n: z.number() }).refine((v) => v.n % 2 === 0, "n must be even");
    const { model } = fakeModel([{ parsed: { n: 3 } }, { parsed: { n: 4 } }]);
    const result = await generateStructured({
      schema: Refined,
      prompt: "even",
      tier: "fast",
      config,
      model,
    });
    expect(result).toEqual({ n: 4 });
  });
});

describe("usage reporting", () => {
  it("reports tokens, tier, model and latency for each attempt, including retries", async () => {
    const records: UsageRecord[] = [];
    const { model } = fakeModel([
      { parsed: { title: "" }, usage: [100, 10] },
      { parsed: { title: "Ok" }, usage: [150, 12] },
    ]);
    await run(model, { onUsage: (r) => records.push(r) });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      tier: "heavy",
      model: "heavy-model",
      tokensIn: 100,
      tokensOut: 10,
      validationFailed: true,
    });
    expect(records[1]).toMatchObject({ tokensIn: 150, tokensOut: 12, validationFailed: false });
    expect(records[1].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("uses the model id of the requested tier", async () => {
    const records: UsageRecord[] = [];
    const { model } = fakeModel([{ parsed: { title: "x" } }]);
    await run(model, { tier: "fast", onUsage: (r) => records.push(r) });
    expect(records[0]).toMatchObject({ tier: "fast", model: "fast-model" });
  });

  it("reports zero tokens when the provider returns no usage metadata", async () => {
    const records: UsageRecord[] = [];
    const { model } = fakeModel([{ parsed: { title: "x" } }]);
    await run(model, { onUsage: (r) => records.push(r) });
    expect(records[0]).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });

  it("computes cost from a registered price and flags unknown prices", () => {
    expect(estimateCostUsd("heavy-model", 1_000_000, 1_000_000)).toEqual({
      costUsd: 0,
      costKnown: false,
    });
    setModelPrice("heavy-model", { inputPerMTok: 2, outputPerMTok: 10 });
    const { costUsd, costKnown } = estimateCostUsd("heavy-model", 500_000, 100_000);
    expect(costKnown).toBe(true);
    expect(costUsd).toBeCloseTo(2, 6); // 0.5M * $2 + 0.1M * $10
  });

  it("prices each attempt using the registered price", async () => {
    setModelPrice("heavy-model", { inputPerMTok: 1, outputPerMTok: 1 });
    const records: UsageRecord[] = [];
    const { model } = fakeModel([{ parsed: { title: "x" }, usage: [1_000_000, 1_000_000] }]);
    await run(model, { onUsage: (r) => records.push(r) });
    expect(records[0]).toMatchObject({ costUsd: 2, costKnown: true });
  });
});

describe("UsageTracker", () => {
  it("totals calls, tokens and cost, overall and by tier", async () => {
    setModelPrice("heavy-model", { inputPerMTok: 1, outputPerMTok: 1 });
    const tracker = new UsageTracker();
    await run(fakeModel([{ parsed: { title: "a" }, usage: [1000, 100] }]).model, {
      onUsage: tracker.record,
    });
    await run(fakeModel([{ parsed: { title: "b" }, usage: [500, 50] }]).model, {
      tier: "fast",
      onUsage: tracker.record,
    });
    expect(tracker.totals()).toMatchObject({ calls: 2, tokensIn: 1500, tokensOut: 150 });
    expect(tracker.totals().costComplete).toBe(false); // the fast model has no price
    expect(tracker.totalsByTier().heavy).toMatchObject({
      calls: 1,
      tokensIn: 1000,
      costComplete: true,
    });
    expect(tracker.totalsByTier().fast).toMatchObject({ calls: 1, tokensIn: 500 });
  });

  it("starts empty", () => {
    expect(new UsageTracker().totals()).toEqual({
      calls: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      costComplete: true,
    });
  });
});

describe("createChatModel", () => {
  it.each([
    ["anthropic", ChatAnthropic],
    ["openai", ChatOpenAI],
    ["google", ChatGoogleGenerativeAI],
  ] as const)("builds a %s model", (provider, Class) => {
    const model = createChatModel("heavy", { ...config, provider });
    expect(model).toBeInstanceOf(Class);
  });

  it("picks the model id for the tier", () => {
    const heavy = createChatModel("heavy", config) as unknown as { model: string };
    const fast = createChatModel("fast", config) as unknown as { model: string };
    expect(heavy.model).toBe("heavy-model");
    expect(fast.model).toBe("fast-model");
  });
});

describe("llmConfigFromEnv", () => {
  it("maps the server environment to a config", () => {
    const env = parseServerEnv({
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "a",
      SUPABASE_SERVICE_ROLE_KEY: "s",
      LLM_PROVIDER: "google",
      LLM_API_KEY: "k",
      LLM_MODEL_HEAVY: "h",
      LLM_MODEL_FAST: "f",
    });
    expect(llmConfigFromEnv(env)).toEqual({
      provider: "google",
      apiKey: "k",
      models: { heavy: "h", fast: "f" },
    });
  });
});

describe("formatIssues", () => {
  it("lists the path and message of each problem", () => {
    const result = Answer.safeParse({ title: "", count: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const text = formatIssues(result.error);
      expect(text).toContain("title");
      expect(text).toContain("count");
    }
  });

  it("truncates very long reports", () => {
    const Big = z.object({ items: z.array(z.object({ v: z.string().min(1000) })) });
    const result = Big.safeParse({ items: Array.from({ length: 50 }, () => ({ v: "" })) });
    if (!result.success) expect(formatIssues(result.error).length).toBeLessThanOrEqual(803);
  });
});
