/**
 * Runtime defense-in-depth for the tenant-isolation contract (T2.1; see
 * `docs/decisions/0001-tenant-isolation-enforcement.md`).
 *
 * The primary guard is TypeScript's type system: every exported DAL
 * function that reads or writes a campaign-scoped table declares
 * `campaignId: string` as a required, non-optional first parameter, so a
 * caller omitting it fails `tsc` (see `tests/isolation/isolation.test.ts`
 * for a suite that also probes this at runtime, since an `any`-typed or
 * dynamically-constructed caller — a route handler deserializing a request
 * body, a test — can still smuggle a falsy value past the compiler).
 *
 * `assertCampaignId` is that second, runtime line of defense: every scoped
 * DAL function calls it before touching the database, so a caller that
 * defeats the type system still gets a hard failure instead of a silent
 * unscoped (or accidentally-cross-campaign) query.
 */
export function assertCampaignId(campaignId: string, fnName: string): void {
  if (typeof campaignId !== "string" || campaignId.length === 0) {
    throw new Error(
      `${fnName}: campaignId is required and must be a non-empty string ` +
        "(tenant-isolation contract — see " +
        "docs/decisions/0001-tenant-isolation-enforcement.md).",
    );
  }
}
