/**
 * Postgres enum types mirroring the string-literal unions in
 * `types/domain.ts` (T1.2). Keep these values in lockstep with that file.
 */
import { pgEnum } from "drizzle-orm/pg-core";

/** Mirrors `CampaignState`. */
export const campaignStateEnum = pgEnum("campaign_state", [
  "draft",
  "live",
  "closed",
]);

/** Mirrors `TargetState`. */
export const targetStateEnum = pgEnum("target_state", [
  "red",
  "amber",
  "green",
]);

/** Mirrors `SubmissionDecision`. */
export const submissionDecisionEnum = pgEnum("submission_decision", [
  "pending",
  "approved",
  "rejected",
  "needs_review",
]);

/** Mirrors `PrivacySetting`. */
export const privacySettingEnum = pgEnum("privacy_setting", [
  "public_username",
  "admin_only",
]);

/** Mirrors `SettlementMode`. Only `manual` exists in v1. */
export const settlementModeEnum = pgEnum("settlement_mode", ["manual"]);

/** Mirrors `UserType`. */
export const userTypeEnum = pgEnum("user_type", ["site_admin", "host"]);
