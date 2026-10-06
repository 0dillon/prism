/**
 * Runs once when the Next.js server starts. Fails fast with a clear message if a
 * required server variable is missing. Skipped during `next build` so CI can build
 * without secrets; runtime reads still validate through `serverEnv()`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { serverEnv } = await import("@/lib/env");
  serverEnv();
}
