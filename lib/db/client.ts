/**
 * Pooled application database client (T1.5).
 *
 * Constitution §6 anti-pattern: "Raw Postgres connections from serverless
 * functions → connection exhaustion under load; always go through a
 * pooler." Every request-path route/lib module MUST import `db` from this
 * file rather than opening its own `postgres()` connection.
 *
 * Pooling strategy: `DATABASE_URL` is expected to point at a **transaction
 * -mode pooler endpoint** (Supabase/Supavisor port 6543, or an equivalent
 * PgBouncer transaction-pooling endpoint) rather than Postgres' own port
 * 5432. The `postgres-js` driver instance below is a single module-level
 * singleton reused across warm serverless invocations (Vercel/Node.js
 * functions keep the module cache alive between invocations on the same
 * instance) — it does not open a new raw connection per call. `prepare:
 * false` disables server-side prepared statements, which transaction-mode
 * poolers do not support (a statement can be routed to a different backend
 * connection on every query).
 *
 * This is distinct from `lib/db/migrate.ts`, which is a one-off script
 * (not a request path) and is explicitly exempt from this rule — it opens
 * its own short-lived `max: 1` connection, ideally against the *direct*
 * (non-pooled) connection string since migrations use session-level
 * features poolers can interfere with.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

declare global {
  // `var` is required here — TypeScript's `declare global` augmentation
  // only supports `var`, not `let`/`const`.
  var __dbClient: postgres.Sql | undefined;
}

function createClient(): postgres.Sql {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required. Point it at a pooled Postgres+PostGIS " +
        "connection string (see .env.example / docs/deploy.md).",
    );
  }

  return postgres(connectionString, {
    // Modest ceiling per serverless instance — the pooler (Supavisor/
    // PgBouncer), not this driver, is what protects Postgres from
    // connection exhaustion across many concurrent instances.
    max: 10,
    idle_timeout: 20,
    // Transaction-mode poolers can hand out a different backend
    // connection per statement, so server-side prepared statements
    // (which are backend-connection-scoped) must be disabled.
    prepare: false,
  });
}

// In dev, Next.js hot-reloads modules on every save, which would otherwise
// leak a new connection pool per reload. Cache the client on `globalThis`
// (dev only) so it survives HMR; in production/serverless each cold start
// gets a fresh module scope anyway, so the cache is a harmless no-op there.
const client = globalThis.__dbClient ?? createClient();
if (process.env.NODE_ENV !== "production") {
  globalThis.__dbClient = client;
}

/** The single pooled Drizzle client the rest of the app imports. */
export const db: PostgresJsDatabase<typeof schema> = drizzle(client, {
  schema,
});
