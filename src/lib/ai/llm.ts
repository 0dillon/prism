import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { z } from "zod";
import { serverEnv, type ServerEnv } from "@/lib/env";
import { logger } from "@/lib/log";
import { estimateCostUsd, type Tier, type UsageCallback } from "./usage";

/**
 * LLM gateway (PRD 0.2, 6.2, 7.2). Every LLM call in Prism goes through here.
 *
 * - Two tiers behind one interface: `heavy` for extraction and merge, `fast` for
 *   intents, grading, variants, and grounding checks.
 * - Every call returns structured output validated by Zod. On a validation failure it
 *   retries once with the error message, then fails with a logged error.
 * - Token use, latency, and cost are reported per attempt through `onUsage`.
 */

export type Provider = ServerEnv["LLM_PROVIDER"];

export interface LlmConfig {
  provider: Provider;
  apiKey: string;
  models: Record<Tier, string>;
}

export function llmConfigFromEnv(env: ServerEnv = serverEnv()): LlmConfig {
  return {
    provider: env.LLM_PROVIDER,
    apiKey: env.LLM_API_KEY,
    models: { heavy: env.LLM_MODEL_HEAVY, fast: env.LLM_MODEL_FAST },
  };
}

/**
 * Builds the chat model for a tier. Sampling parameters are left at the provider's
 * defaults on purpose: some current models reject or degrade with custom temperatures.
 * Transient provider errors (rate limits, timeouts) are retried by the client.
 */
export function createChatModel(tier: Tier, config: LlmConfig = llmConfigFromEnv()): BaseChatModel {
  const model = config.models[tier];
  switch (config.provider) {
    case "anthropic":
      return new ChatAnthropic({ model, apiKey: config.apiKey, maxRetries: 3 });
    case "openai":
      return new ChatOpenAI({ model, apiKey: config.apiKey, maxRetries: 3 });
    case "google":
      return new ChatGoogleGenerativeAI({ model, apiKey: config.apiKey, maxRetries: 3 });
  }
}

/** The part of a chat model that `generateStructured` uses. Lets tests pass a fake. */
export interface StructuredCapableModel {
  withStructuredOutput(
    schema: z.ZodType,
    options: { includeRaw: true; name?: string },
  ): { invoke(messages: BaseMessage[]): Promise<unknown> };
}

export interface GenerateStructuredOptions<S extends z.ZodType> {
  schema: S;
  prompt: string;
  system?: string;
  tier: Tier;
  /** Short task name for logs and the tool name, for example "extract-concepts". */
  name?: string;
  config?: LlmConfig;
  /** Override the model. Used by tests. */
  model?: StructuredCapableModel;
  onUsage?: UsageCallback;
}

export class StructuredOutputError extends Error {
  constructor(
    public readonly task: string,
    public readonly issues: string,
    public readonly attempts: number,
  ) {
    super(`LLM output for "${task}" failed validation after ${attempts} attempts: ${issues}`);
    this.name = "StructuredOutputError";
  }
}

const MAX_ATTEMPTS = 2; // the first try plus one retry with the error message
const MAX_ISSUE_CHARS = 800;

/** Compact, model-readable description of what was wrong with an output. */
export function formatIssues(error: z.ZodError): string {
  const text = error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
  return text.length > MAX_ISSUE_CHARS ? `${text.slice(0, MAX_ISSUE_CHARS)}...` : text;
}

interface RawResult {
  parsed: unknown;
  parsingError: unknown;
  tokensIn: number;
  tokensOut: number;
}

function readResult(result: unknown): RawResult {
  const record = (result ?? {}) as {
    parsed?: unknown;
    parsingError?: unknown;
    raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } };
  };
  const usage = record.raw?.usage_metadata;
  return {
    parsed: record.parsed ?? null,
    parsingError: record.parsingError ?? null,
    tokensIn: usage?.input_tokens ?? 0,
    tokensOut: usage?.output_tokens ?? 0,
  };
}

/** Whether a thrown error means "the model's output could not be parsed", as opposed to a transport failure. */
function isOutputParsingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { lc_error_code?: string }).lc_error_code;
  return error.name === "OutputParserException" || code === "OUTPUT_PARSING_FAILURE";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, MAX_ISSUE_CHARS) : String(error);
}

/**
 * Calls the model and returns output that has been validated against `schema`.
 * Transport and authentication errors are thrown as they are; only output that fails
 * to parse or validate is retried (once, with the problem described to the model).
 */
export async function generateStructured<S extends z.ZodType>(
  options: GenerateStructuredOptions<S>,
): Promise<z.infer<S>> {
  const { schema, tier, onUsage } = options;
  const task = options.name ?? "structured-output";
  const config = options.config ?? (options.model ? undefined : llmConfigFromEnv());
  const modelId = config?.models[tier] ?? "injected-model";
  const model =
    options.model ?? (createChatModel(tier, config) as unknown as StructuredCapableModel);
  const runnable = model.withStructuredOutput(schema, { includeRaw: true, name: task });

  const messages: BaseMessage[] = [];
  if (options.system) messages.push(new SystemMessage(options.system));
  messages.push(new HumanMessage(options.prompt));

  let lastIssues = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const startedAt = Date.now();
    let tokensIn = 0;
    let tokensOut = 0;
    let issues: string | null = null;
    let value: z.infer<S> | undefined;

    try {
      const result = readResult(await runnable.invoke(messages));
      tokensIn = result.tokensIn;
      tokensOut = result.tokensOut;

      if (result.parsed === null) {
        issues = result.parsingError
          ? `the output could not be parsed: ${describeError(result.parsingError)}`
          : "the model returned no structured output";
      } else {
        const checked = schema.safeParse(result.parsed);
        if (checked.success) value = checked.data;
        else issues = formatIssues(checked.error);
      }
    } catch (error) {
      if (!isOutputParsingError(error)) throw error;
      issues = `the output could not be parsed: ${describeError(error)}`;
    }

    if (onUsage) {
      const { costUsd, costKnown } = estimateCostUsd(modelId, tokensIn, tokensOut);
      onUsage({
        tier,
        model: modelId,
        tokensIn,
        tokensOut,
        costUsd,
        costKnown,
        latencyMs: Date.now() - startedAt,
        validationFailed: issues !== null,
      });
    }

    if (issues === null) return value as z.infer<S>;

    lastIssues = issues;
    logger.warn("llm structured output rejected", { task, tier, model: modelId, attempt, issues });
    messages.push(
      new HumanMessage(
        `Your previous answer was rejected: ${issues}. Answer again and fix exactly these problems.`,
      ),
    );
  }

  logger.error("llm structured output failed", {
    task,
    tier,
    model: modelId,
    attempts: MAX_ATTEMPTS,
    issues: lastIssues,
  });
  throw new StructuredOutputError(task, lastIssues, MAX_ATTEMPTS);
}
