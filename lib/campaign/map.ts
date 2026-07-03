/**
 * Per-campaign map domain logic (T4.4) — PRD FR-M2, FR-M3, FR-M4, FR-M7.
 *
 * Constitution §6: domain logic lives in `lib/`, never in route handlers —
 * `app/campaigns/[id]/map/page.tsx` (initial server render),
 * `app/api/campaigns/[id]/targets/route.ts` (the poll list), and
 * `app/api/campaigns/[id]/targets/[targetId]/route.ts` (the tap-through
 * detail) are all thin callers into `listMapPins`/`getTargetDetail` below.
 * Constitution §5: authorization is server-side on every call — both
 * exports take a `MapPrincipal` and enforce it themselves (mirrors
 * `lib/review/queue.ts`'s `listReviewQueue`, which calls
 * `requireCampaignAccess` internally rather than trusting each of its
 * three call sites to remember to) — a caller cannot reach either DAL read
 * without first resolving who's asking.
 *
 * Two read shapes, deliberately different:
 * - `listMapPins` (requirement 1/5, the 5-10s polling list): only
 *   `id`/`label`/`lat`/`long`/`state` — enough to color a pin, nothing
 *   about *who* claimed an amber pin. Every other player polling the same
 *   campaign's map has no legitimate reason to see another player's
 *   identity merely because they tapped a red pin first.
 * - `getTargetDetail` (requirement 3/4, a single tap-through): the fuller
 *   view — photo, submission GPS, and the canvasser's identity for a
 *   filled (`green`) pin, gated by `campaign.privacySetting` exactly like
 *   PRD FR-M4/constitution §5 ("username on green pin defaults to
 *   admin-only"). `lib/review/queue.ts` (T4.2) is the precedent for this
 *   shape (signed photo URL + resolved `Player` alongside the `Target`)
 *   — this module is that same assembly, but for the player-facing map
 *   instead of the host-facing review queue, and with the privacy gate
 *   review queue doesn't need (a host can always see the canvasser).
 */
import { requireCampaignAccess } from "@/lib/auth/guards";
import type { StaffPrincipal } from "@/lib/auth/staff";
import { getCampaignById } from "@/lib/db/dal/campaigns";
import { getMembership } from "@/lib/db/dal/campaign-memberships";
import { getTarget, listTargets } from "@/lib/db/dal/targets";
import { getSubmission } from "@/lib/db/dal/submissions";
import { getPlayerById } from "@/lib/db/dal/players";
import { createSignedGetUrl } from "@/lib/storage/r2";
import { TargetNotFoundError } from "@/lib/target/state-machine";
import type {
  Coordinate,
  PlaceDetails,
  Target,
  TargetState,
} from "@/types/domain";

/** Thrown when `campaignId` doesn't resolve to a campaign at all — the map
 * routes' 404 case, distinct from `TargetNotFoundError` (a real campaign,
 * unknown/foreign target). */
export class CampaignNotFoundError extends Error {
  readonly status = 404 as const;
  readonly code = "campaign_not_found" as const;

  constructor(campaignId: string) {
    super(`campaign ${campaignId} not found`);
    this.name = "CampaignNotFoundError";
  }
}

/**
 * Who's asking. A `player` may view any campaign's *pin list*
 * (`listMapPins`: there's no membership gate on that kind of browsing,
 * see the route handlers' doc comments) and is subject to
 * `campaign.privacySetting`'s username gate on a green pin's detail
 * (requirement 3). `playerId` is required (not just "some player is
 * signed in") because `getTargetDetail` additionally gates a filled pin's
 * *photo and GPS* on campaign membership (batch-4 review fix, Liotta),
 * see that function's doc comment. A `staff` viewer (site admin, or a
 * host scoped by `requireCampaignAccess` below) may only view campaigns
 * it's authorized for, and always sees a filled pin's full detail
 * unconditionally, same as the review queue (T4.2).
 */
export type MapPrincipal =
  | { type: "player"; playerId: string }
  | { type: "staff"; staff: StaffPrincipal };

function assertMapAccess(principal: MapPrincipal, campaignId: string): void {
  if (principal.type === "staff") {
    requireCampaignAccess(principal.staff, campaignId);
  }
  // No membership gate for a player here, see `listMapPins`'s doc
  // comment (the pin-color list is a deliberate public read: id/label/
  // lat/long/state only, nothing sensitive). `getTargetDetail` layers its
  // own, stricter membership check on top of this for the fields that
  // *are* sensitive (photo, GPS).
}

/** One pin for the live map / poll list (card requirement 1/5). */
export interface MapPin {
  id: string;
  label: string;
  placeDetails: PlaceDetails | null;
  lat: number;
  long: number;
  state: TargetState;
}

function toPin(target: Target): MapPin {
  return {
    id: target.id,
    label: target.label,
    lat: target.lat,
    long: target.long,
    state: target.state,
    placeDetails: target.placeDetails,
  };
}

/**
 * Lists every pin for `campaignId`'s map (card requirement 1), scoped to
 * `principal`'s access. Throws `CampaignNotFoundError` if `campaignId`
 * doesn't resolve — without this check, a nonexistent campaign id would
 * silently render as an empty (rather than a 404) map, indistinguishable
 * from a real, merely-pinless campaign.
 */
export async function listMapPins(
  principal: MapPrincipal,
  campaignId: string,
): Promise<MapPin[]> {
  assertMapAccess(principal, campaignId);
  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);
  const targets = await listTargets(campaignId);
  return targets.map(toPin);
}

/** The full tap-through view for one pin (card requirements 3/4).
 * `photoUrl`/`submissionGps`/`username` are populated only when the
 * target is `green` (filled) *and* the viewer is privileged to see them:
 * `null` in every other case, including a `red`/`amber` tap (requirement
 * 4: those get an "informational" state-only view, not an error). */
export interface TargetDetail {
  id: string;
  label: string;
  lat: number;
  long: number;
  state: TargetState;
  /** `null` unless the pin is filled AND the viewer is staff or a member
   * of this campaign (batch-4 review fix, Liotta; see `getTargetDetail`'s
   * doc comment). */
  photoUrl: string | null;
  /** Same gate as `photoUrl`: the canvasser's device GPS is exactly as
   * sensitive as their photo. */
  submissionGps: Coordinate | null;
  /**
   * The canvasser's email address, standing in for "username" (the
   * platform has no separate handle: `types/domain.ts`'s `Player` is just
   * `{ id, email }`). `null` when the pin isn't filled yet, or when it is
   * but `principal` isn't privileged to see it under
   * `campaign.privacySetting` (PRD FR-M4 default: admin-only). This gate
   * is independent of `photoUrl`/`submissionGps`'s membership gate: a
   * non-member player under `public_username` still sees the username,
   * matching this field's pre-existing behavior.
   */
  username: string | null;
  /** Business details (address/phone/website/hours) enriched from OSM. Not
   * sensitive — returned for any pin state, independent of the photo/username
   * gates above. `null` when OSM had no match for this business. */
  placeDetails: PlaceDetails | null;
}

/**
 * Resolves one target's full tap-through detail (card requirements 3/4),
 * scoped to `principal`'s access. Throws `CampaignNotFoundError`/
 * `TargetNotFoundError` (typed, per constitution §3 — "no silent
 * catches") if either doesn't resolve; the route handler translates those
 * to 404s.
 *
 * ## Photo/GPS membership gate (batch-4 review fix, Liotta)
 * A filled pin's photo and the canvasser's device GPS are sensitive
 * (constitution §5): unlike the pin-color list, this is not one of the
 * constitution's named public reads ("landing/universal map"). A `player`
 * principal only sees them when they're a member of `campaignId`; a
 * non-member player gets the same null fields a red/amber tap already
 * returns (this is the tap-through's existing "informational, nothing to
 * reveal" shape, not a new error path; no signed URL is even minted for
 * a viewer who can't use it). `username` keeps its existing, independent
 * `privacySetting` gate (unchanged by this fix); a staff viewer always
 * sees everything, same as before.
 */
export async function getTargetDetail(
  principal: MapPrincipal,
  campaignId: string,
  targetId: string,
): Promise<TargetDetail> {
  assertMapAccess(principal, campaignId);

  const campaign = await getCampaignById(campaignId);
  if (!campaign) throw new CampaignNotFoundError(campaignId);

  const target = await getTarget(campaignId, targetId);
  if (!target) throw new TargetNotFoundError(campaignId, targetId);

  // Red/amber taps are purely informational (requirement 4) — nothing to
  // reveal about a target that hasn't been filled yet.
  if (target.state !== "green" || !target.filledBySubmissionId) {
    return {
      id: target.id,
      label: target.label,
      lat: target.lat,
      long: target.long,
      state: target.state,
      photoUrl: null,
      submissionGps: null,
      username: null,
      placeDetails: target.placeDetails,
    };
  }

  const canSeeSensitiveDetail =
    principal.type === "staff" ||
    Boolean(await getMembership(campaignId, principal.playerId));

  const [submission, photoUrl] = await Promise.all([
    getSubmission(campaignId, target.filledBySubmissionId),
    canSeeSensitiveDetail
      ? createSignedGetUrl(campaignId, target.filledBySubmissionId)
      : Promise.resolve(null),
  ]);
  const player = submission ? await getPlayerById(submission.playerId) : null;

  const usernameAllowed =
    principal.type === "staff" || campaign.privacySetting === "public_username";

  return {
    id: target.id,
    label: target.label,
    lat: target.lat,
    long: target.long,
    state: target.state,
    photoUrl,
    submissionGps:
      canSeeSensitiveDetail && submission ? submission.deviceGps : null,
    username: usernameAllowed ? (player?.email ?? null) : null,
    placeDetails: target.placeDetails,
  };
}
