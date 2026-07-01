import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for unit + integration tests (T1.4). Playwright e2e specs
 * under `tests/e2e/` are excluded — they run via `pnpm test:e2e` instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
