/**
 * One-off migration runner: `pnpm db:migrate`.
 *
 * This is a script entry point, not a serverless request path — it is
 * exempt from the "pooled connection only" rule in constitution §6 (that
 * rule targets per-request connections from Vercel functions; a single
 * short-lived connection to run migrations once is the standard pattern).
 * The pooled application client lives in `lib/db/client.ts` (T1.5).
 *
 * Usage: DATABASE_URL=postgres://... pnpm db:migrate
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  // max: 1 — a single connection is sufficient for a one-shot migration run.
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);

  await migrate(db, { migrationsFolder: "lib/db/migrations" });

  await sql.end();
}

main()
  .then(() => {
    console.log("Migrations applied successfully.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
