/**
 * Test DB setup/teardown helpers (T1.4).
 *
 * Integration tests run against a real local/CI Postgres+PostGIS instance
 * (constitution §2's chosen test stack; card anti-requirement: "do NOT
 * depend on a deployed environment"). This module never opens a connection
 * of its own at import time — tests that need the DB call `getTestDb()`
 * explicitly, so purely unit-level tests (e.g. `tests/smoke.test.ts`) never
 * pay for or require a DB connection.
 *
 * `DATABASE_URL` is the same env var the app and `lib/db/migrate.ts` use
 * (see `.env.example`); point it at a disposable test database, never a
 * shared/deployed one. `hasTestDatabase()` lets a test file skip itself
 * gracefully when no test DB is configured, rather than failing `pnpm test`
 * in environments where one isn't wired up yet.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

export type TestDb = PostgresJsDatabase<typeof schema>;

let client: postgres.Sql | undefined;
let db: TestDb | undefined;

/** True when a `DATABASE_URL` is configured for this test run. */
export function hasTestDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Lazily creates (and memoizes) a single pooled-for-tests connection to
 * `DATABASE_URL`. Call `closeTestDb()` in a suite's `afterAll` to release it.
 */
export function getTestDb(): TestDb {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Point it at a local/CI Postgres+PostGIS " +
        "test database before running DB-dependent tests.",
    );
  }
  if (!db) {
    client = postgres(process.env.DATABASE_URL, { max: 5 });
    db = drizzle(client, { schema });
  }
  return db;
}

/** Closes the shared test connection. Safe to call even if never opened. */
export async function closeTestDb(): Promise<void> {
  if (client) {
    await client.end();
    client = undefined;
    db = undefined;
  }
}

/**
 * Resets all mutable application tables between tests so state never leaks
 * across test runs (card requirement 5). A single multi-table `TRUNCATE
 * ... CASCADE` is used instead of per-table statements/transaction
 * rollback — it's order-independent (no need to hand-sort FK dependencies)
 * and works whether a test committed via one connection or several.
 */
export async function resetTestDb(testDb: TestDb): Promise<void> {
  await testDb.execute(sql`
    TRUNCATE TABLE
      payout_ledger,
      submissions,
      campaign_memberships,
      targets,
      user_campaigns,
      campaigns,
      players,
      users
    RESTART IDENTITY CASCADE
  `);
}
