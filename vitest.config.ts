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
    server: {
      deps: {
        // next-auth (ESM) does extensionless `import ... from "next/server"`.
        // Next.js's own bundler (webpack/Turbopack) resolves that fine, but
        // Vitest's default SSR module loader treats "next" as an external
        // and falls back to strict Node ESM resolution, which requires an
        // explicit extension and fails. Inlining forces Vite to transform
        // next-auth (and its @auth/core dependency) itself, which resolves
        // the specifier the same permissive way the app's own bundler does.
        inline: ["next-auth", "@auth/core"],
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
