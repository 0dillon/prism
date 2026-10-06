import { defineConfig, devices } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "src/tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // Set PW_CHANNEL=msedge (or chrome) to reuse an installed browser instead of downloading one.
      use: { ...devices["Desktop Chrome"], channel: process.env.PW_CHANNEL || undefined },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    // Placeholders let the server start without real secrets. The e2e tests here only
    // cover pages that do not need the database or the LLM.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "e2e-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "e2e-service-key",
      LLM_PROVIDER: process.env.LLM_PROVIDER ?? "google",
      LLM_API_KEY: process.env.LLM_API_KEY ?? "e2e-llm-key",
      LLM_MODEL_HEAVY: process.env.LLM_MODEL_HEAVY ?? "e2e-heavy",
      LLM_MODEL_FAST: process.env.LLM_MODEL_FAST ?? "e2e-fast",
    },
  },
});
