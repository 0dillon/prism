import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    // Component tests opt in to jsdom with `// @vitest-environment jsdom`.
    environment: "node",
    include: ["src/tests/unit/**/*.test.{ts,tsx}", "src/tests/sql/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    setupFiles: ["src/tests/setup.ts"],
  },
});
