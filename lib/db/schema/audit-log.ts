/**
 * Audit log (T4.2) — PRD FR-R1…FR-R4, constitution §5: "immutable,
 * append-only log of all approvals, rejections, manual adjustments,
 * settlements, and claim events." Campaign-scoped table (`campaign_id` is
 * non-null and indexed), same isolation posture as `targets`/`submissions`
 * even though it isn't one of the constitution §3-named four ("targets,
 * submissions, campaign_memberships, payout_ledger") — see
 * `lib/db/dal/audit-log.ts`'s doc comment for why it still follows the
 * same required-`campaignId`-first-parameter DAL contract.
 *
 * `submissionId`/`playerId` are nullable: a manual point/payout adjustment
 * (FR-R4) may target a player directly without a specific submission in
 * play. `actorUserId` is the staff user who performed the action for every
 * host-driven decision (approve/reject/adjust), nullable only for the one
 * system-driven action a human never makes: `lib/capture/submit.ts`'s
 * auto-approve dispatch (batch-4 review fix, Liotta), which logs an
 * `approve` entry with `actorUserId: null` so auto-approved payout
 * obligations still have a "who/when" audit row for dispute investigation
 * (the "who" being "the pipeline," recorded as `null` rather than an
 * invented human actor).
 *
 * Immutability is enforced by convention, the same way `payout_ledger`
 * (also "immutable, append-only" per its own doc comment) is: the DAL
 * (`lib/db/dal/audit-log.ts`) exposes only insert/list functions, no
 * update/delete.
 */
import { pgTable, uuid, text, index } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";
import { campaigns } from "./campaigns";
import { submissions } from "./submissions";
import { players } from "./players";
import { users } from "./users";

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    submissionId: uuid("submission_id").references(() => submissions.id),
    playerId: uuid("player_id").references(() => players.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    /** e.g. "approve" | "reject" | "adjust" — kept as free `text`, not a
     * pg enum, since FR-R4's manual-adjustment action set is open-ended
     * (constitution §3 naming: `SCREAMING_SNAKE_CASE` is for env vars
     * only; this is plain data). */
    action: text("action").notNull(),
    reason: text("reason"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [index("audit_log_campaign_id_idx").on(table.campaignId)],
);
