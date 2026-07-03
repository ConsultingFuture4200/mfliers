/**
 * Shared domain types — Flier Canvassing Platform (PRD §8).
 *
 * Leaf-level: no imports from `lib/` or anywhere else in the project.
 * Pure types only — no runtime logic (validation lives with the DAL/handlers,
 * Drizzle schema lives in T1.3's `lib/db/schema.ts`).
 *
 * Money: every monetary field is a `number` representing **integer cents**
 * (never floats/decimals) per constitution §3.
 * Time: timestamps are `Date` in the domain layer (serialized to ISO strings
 * at API boundaries).
 */

// ---------------------------------------------------------------------------
// Enums / string-literal unions
// ---------------------------------------------------------------------------

/** Campaign lifecycle state. */
export type CampaignState = "draft" | "live" | "closed";

/** Target (map pin) claim state. */
export type TargetState = "red" | "amber" | "green";

/** Submission review decision. */
export type SubmissionDecision =
  "pending" | "approved" | "rejected" | "needs_review";

/** Who can see the player's username on a green (completed) pin. */
export type PrivacySetting = "public_username" | "admin_only";

/** How payout obligations are settled. Only `manual` exists in v1; kept as a
 * union so Phase 3 payment rails can extend it without a breaking type change. */
export type SettlementMode = "manual";

/** Staff account type. Site admins are platform-wide; hosts are scoped to
 * `scoped_campaign_ids`. */
export type UserType = "site_admin" | "host";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/** A WGS84 lat/long pair. Stored in PostGIS as geography(Point,4326). */
export interface Coordinate {
  lat: number;
  long: number;
}

/** One band of a campaign's payout tier curve. Bands are ordered and
 * contiguous; `maxCount: null` means "and above" (the top/open-ended band). */
export interface TierBand {
  minCount: number;
  maxCount: number | null;
  /** Payout for a submission in this band, in integer cents. */
  payoutCents: number;
}

/** An ordered array of tier bands defining a campaign's payout curve. */
export type TierTable = TierBand[];

/** Result of a single fraud check run against a submission. */
export interface FraudCheckResult {
  /** Identifier of the check that ran, e.g. "dedupe", "geo", "time". */
  check: string;
  passed: boolean;
  detail: string;
  /** Optional confidence/severity score for the check, if applicable. */
  score?: number;
}

// ---------------------------------------------------------------------------
// Core entities (PRD §8)
// ---------------------------------------------------------------------------

/** A flier-canvassing campaign (tenant). */
export interface Campaign {
  id: string;
  name: string;
  flierImageUrl: string;
  /** Total campaign budget, in integer cents. */
  budgetCapCents: number;
  tierTable: TierTable;
  grandPrize: string;
  privacySetting: PrivacySetting;
  /** Radius (meters) within which a submission's location must fall relative
   * to its target, for PostGIS ST_DWithin checks. */
  proximityRadiusM: number;
  settlementMode: SettlementMode;
  state: CampaignState;
  hostId: string;
  startAt: Date;
  endAt: Date;
}

/** Optional business details for a target, enriched from OpenStreetMap (a
 * one-time backfill, `scripts/enrich-targets.ts`). All fields optional — OSM
 * coverage is partial; a target with no OSM match keeps `place_details` null. */
export interface PlaceDetails {
  address?: string;
  phone?: string;
  website?: string;
  hours?: string;
}

/** A map pin a player can claim, post a flier at, and submit a photo for. */
export interface Target {
  id: string;
  campaignId: string;
  label: string;
  lat: number;
  long: number;
  state: TargetState;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  filledBySubmissionId: string | null;
  placeDetails: PlaceDetails | null;
}

/** A player's geotagged photo submission for a claimed target. */
export interface Submission {
  id: string;
  campaignId: string;
  playerId: string;
  targetId: string;
  photoUrl: string;
  /** GPS reported by the capturing device at submit time. */
  deviceGps: Coordinate;
  /** GPS embedded in the photo's EXIF metadata. */
  exifGps: Coordinate | null;
  /** Timestamp embedded in the photo's EXIF metadata (not authoritative). */
  exifTs: Date | null;
  /** Server-stamped receipt time; authoritative for payout/fraud logic. */
  receivedAt: Date;
  /** Perceptual hash of the photo, used for dedupe checks. */
  phash: string;
  fraudChecks: FraudCheckResult[];
  decision: SubmissionDecision;
  decidedBy: string | null;
  decidedAt: Date | null;
}

/** A player account. Email address is the global login identity across all
 * campaigns. */
export interface Player {
  id: string;
  email: string;
}

/** A player's participation record within a single campaign. */
export interface CampaignMembership {
  playerId: string;
  campaignId: string;
  approvedCount: number;
  currentTier: number;
  /** Amount owed to the player for this campaign, in integer cents. */
  balanceOwedCents: number;
  rank: number;
}

/** An immutable ledger entry recording a payout obligation created by an
 * approved submission. */
export interface PayoutLedgerEntry {
  id: string;
  campaignId: string;
  submissionId: string;
  playerId: string;
  /** Amount of this ledger entry, in integer cents. */
  amountCents: number;
  /** The tier the player was on at the time this entry was created. */
  tierAtTime: number;
  /** Running total of *payable* committed payouts for the campaign at this
   * entry, in integer cents (T4.3). Never includes an `unpayable` entry's
   * amount — see `unpayable` below. */
  cumulativeCommittedCents: number;
  /** True when this entry would have pushed `cumulativeCommittedCents`
   * past the campaign's `budgetCapCents` (T4.3, PRD FR-P3 "at-cap"
   * behavior). An unpayable entry's `amountCents` is always `0` — the
   * submission is still approved (the pin still turns green) but no
   * payable amount accrues. `tierAtTime` still records the band the
   * submission would have earned, for host/audit visibility. */
  unpayable: boolean;
  settled: boolean;
  settledAt: Date | null;
}

/** A staff account (site admin or host). */
export interface User {
  id: string;
  type: UserType;
  /** Campaign IDs this user is authorized for. Empty/ignored for
   * `site_admin`, who is platform-wide. */
  scopedCampaignIds: string[];
}

/** An audited staff action (T4.2, PRD FR-R1…FR-R4). Immutable, append-only
 * — never updated or deleted once written. */
export type AuditAction = "approve" | "reject" | "adjust" | "settle";

/** One row of the immutable audit log (constitution §5: "immutable,
 * append-only log of all approvals, rejections, manual adjustments,
 * settlements, and claim events"). */
export interface AuditLogEntry {
  id: string;
  campaignId: string;
  /** Null for an action not tied to a specific submission (e.g. a
   * player-level manual adjustment, FR-R4). */
  submissionId: string | null;
  playerId: string | null;
  /** The staff user (`users.id`) who performed the action, or `null` for
   * the one system-driven action (`lib/capture/submit.ts`'s auto-approve
   * dispatch) that no human decided. */
  actorUserId: string | null;
  action: AuditAction;
  reason: string | null;
  createdAt: Date;
}
