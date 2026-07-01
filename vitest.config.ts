import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest config for unit + integration tests (T1.4). Playwright e2e specs
 * under `tests/e2e/` are excluded — they run via `pnpm test:e2e` instead.
 *
 * `fileParallelism: false` (Liotta review, batch 1): `tests/setup.ts`'s
 * `resetTestDb()` does a single shared-`DATABASE_URL` `TRUNCATE ... CASCADE`
 * across every campaign-scoped table. Vitest runs test *files* in separate
 * parallel workers by default, so two DB-backed test files truncating the
 * same database concurrently would wipe each other's fixture rows mid-run —
 * exactly the kind of flake that would hide in the tenant-isolation suite
 * this harness exists to make trustworthy. Forcing files to run sequentially
 * is the simplest fix that doesn't require per-worker databases/schemas;
 * revisit if the DB-backed test suite grows large enough that sequential
 * runtime becomes a problem.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
