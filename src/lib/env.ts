import { z } from "zod";

/**
 * Typed environment loader (PRD section 7.6).
 *
 * Server variables are validated lazily by `serverEnv()` and eagerly at server
 * startup by `src/instrumentation.ts`. Empty strings count as unset so a copied
 * `.env.example` behaves like a missing variable instead of a blank value.
 */

const nonEmpty = z.string().min(1);

const serverSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
    SUPABASE_SERVICE_ROLE_KEY: nonEmpty,

    LLM_PROVIDER: z.enum(["anthropic", "openai", "google"]),
    LLM_API_KEY: nonEmpty,
    LLM_MODEL_HEAVY: nonEmpty,
    LLM_MODEL_FAST: nonEmpty,

    STT_PROVIDER: nonEmpty.default("browser"),
    STT_API_KEY: nonEmpty.optional(),
    TTS_PROVIDER: nonEmpty.default("browser"),
    TTS_API_KEY: nonEmpty.optional(),

    STRIPE_SECRET_KEY: nonEmpty.optional(),
    STRIPE_WEBHOOK_SECRET: nonEmpty.optional(),
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: nonEmpty.optional(),
    PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(1500),

    INNGEST_EVENT_KEY: nonEmpty.optional(),
    INNGEST_SIGNING_KEY: nonEmpty.optional(),
    SENTRY_DSN: nonEmpty.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.STT_PROVIDER !== "browser" && !env.STT_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["STT_API_KEY"],
        message: `required when STT_PROVIDER is "${env.STT_PROVIDER}"`,
      });
    }
    if (env.TTS_PROVIDER !== "browser" && !env.TTS_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["TTS_API_KEY"],
        message: `required when TTS_PROVIDER is "${env.TTS_PROVIDER}"`,
      });
    }
  });

export type ServerEnv = z.infer<typeof serverSchema>;

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: nonEmpty.optional(),
});

export type ClientEnv = z.infer<typeof clientSchema>;

export class EnvError extends Error {
  constructor(public readonly problems: string[]) {
    super(
      [
        "Invalid environment configuration:",
        ...problems.map((problem) => `  - ${problem}`),
        "Copy .env.example to .env.local and set the missing values.",
      ].join("\n"),
    );
    this.name = "EnvError";
  }
}

type RawEnv = Record<string, string | undefined>;

function dropEmpty(source: RawEnv): RawEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
}

function parseWith<T extends z.ZodType>(schema: T, source: RawEnv): z.infer<T> {
  const raw = dropEmpty(source);
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.join(".");
    if (key && raw[key] === undefined) return `${key} is required but not set`;
    return key ? `${key}: ${issue.message}` : issue.message;
  });
  throw new EnvError(problems);
}

/** Pure parser, exported for tests. Throws `EnvError` listing every problem. */
export function parseServerEnv(source: RawEnv): ServerEnv {
  return parseWith(serverSchema, source);
}

let cachedServerEnv: ServerEnv | undefined;

/** Validated server environment. Never call from client code. */
export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must not be called in the browser");
  }
  cachedServerEnv ??= parseServerEnv(process.env);
  return cachedServerEnv;
}

/**
 * Validated public environment. NEXT_PUBLIC_ variables must be read as static
 * property accesses so Next.js can inline them into the client bundle.
 */
export function clientEnv(): ClientEnv {
  return parseWith(clientSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  });
}
