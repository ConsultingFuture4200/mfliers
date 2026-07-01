import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit config. `pnpm db:generate` diffs `lib/db/schema/` against the
 * migration history and writes new SQL under `lib/db/migrations/`.
 * `pnpm db:migrate` (lib/db/migrate.ts) applies them to `DATABASE_URL`.
 */
export default {
  schema: "./lib/db/schema/index.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
} satisfies Config;
