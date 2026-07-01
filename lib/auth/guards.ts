/**
 * Server-side authorization guards (T2.3) — constitution §5:
 * "Authorization: role-based, enforced server-side on every request. A
 * host token authorizes only its scoped_campaign_ids; a player token
 * authorizes only joined campaigns plus public reads ... UI-only gating is
 * never sufficient." And §6 anti-pattern: "UI-only authorization."
 *
 * This is the server-side half of tenant isolation that complements
 * T2.1's data-layer half (`lib/db/dal/*`'s required `campaignId`
 * parameter): T2.1 makes it impossible to *read* another campaign's rows
 * without naming a `campaignId`; these guards make it impossible for a
 * host/admin route handler to even *reach* that read for a campaign it
 * isn't authorized for. Every host/admin-facing route handler in later
 * batches must call one of these before touching the DAL.
 */
import type { StaffPrincipal } from "./staff";

/**
 * Thrown by both guards on a denied check. Carries `status = 403` so a
 * route handler can translate it directly to an HTTP response
 * (constitution §3: "server logic ... throws typed errors; route handlers
 * translate to HTTP status + JSON `{ error: { code, message } }`").
 */
export class ForbiddenError extends Error {
  readonly status = 403 as const;
  readonly code = "forbidden" as const;

  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Asserts `principal` is authorized for `campaignId`.
 * - `site_admin`: always allowed (platform-wide).
 * - `host`: allowed only if `campaignId` is in `principal.scopedCampaignIds`.
 *
 * Throws `ForbiddenError` (-> 403) on denial; returns normally on allow.
 * Never grants a host any cross-campaign read — a host outside its
 * `scoped_campaign_ids` is denied exactly like an unrelated stranger.
 */
export function requireCampaignAccess(
  principal: StaffPrincipal,
  campaignId: string,
): void {
  if (principal.type === "site_admin") return;
  if (
    principal.type === "host" &&
    principal.scopedCampaignIds.includes(campaignId)
  ) {
    return;
  }
  throw new ForbiddenError(
    `user ${principal.userId} is not authorized for campaign ${campaignId}`,
  );
}

/**
 * Asserts `principal` is a `site_admin`. Throws `ForbiddenError` (-> 403)
 * for a `host` principal; returns normally for a `site_admin`.
 */
export function requireSiteAdmin(principal: StaffPrincipal): void {
  if (principal.type !== "site_admin") {
    throw new ForbiddenError(`user ${principal.userId} is not a site admin`);
  }
}
