/**
 * Trivial Vitest smoke test (T1.4). Has no DB dependency, so `pnpm test`
 * proves the Vitest harness itself is wired up correctly even in an
 * environment without a test database configured yet.
 */
import { describe, expect, it } from "vitest";

describe("vitest harness", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
