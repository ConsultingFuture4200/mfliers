/**
 * Audit-log DAL (T4.2) — campaign-scoped (constitution §5: "immutable,
 * append-only log of all approvals, rejections, manual adjustments,
 * settlements, and claim events").
 *
 * `audit_log` isn't one of the constitution §3-named four scoped tables
 * ("targets, submissions, campaign_memberships, payout_ledger"), but it
 * carries a non-null `campaign_id` the same way those do, so this module
 * follows the identical contract anyway: every export requires
 * `campaignId: string` as its first, non-optional parameter and calls
 * `assertCampaignId` before touching the database, per
 * `docs/decisions/0001-tenant-isolation-enforcement.md`'s spirit (a host's
 * audit trail for one campaign must never leak into another's). Flagged in
 * `tasks/lessons.md` as a candidate for a future pass to also register this
 * module in `tests/isolation/isolation.test.ts`'s hardcoded scoped-module
 * list (not edited here — that file isn't in this card's Files list, and
 * per T3.3's precedent that kind of cross-cutting suite update happens in
 * a dedicated review pass, not the introducing card).
 *
 * Immutable/append-only is enforced by omission: this module exposes only
 * `insertAuditEntry`/`listAuditEntries` — no update or delete function
 * exists to mutate a row once written (mirrors `payout-ledger.ts`, which
 * is "immutable, append-only" the same way).
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import type { AuditAction, AuditLogEntry } from "@/types/domain";
import { assertCampaignId } from "./scope";

function toDomain(row: typeof auditLog.$inferSelect): AuditLogEntry {
  return {
    id: row.id,
    campaignId: row.campaignId,
    submissionId: row.submissionId,
    playerId: row.playerId,
    actorUserId: row.actorUserId,
    action: row.action as AuditAction,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/** Input for `insertAuditEntry` — every field the schema requires except
 * `campaignId`/`id`, which are the function's own explicit
 * parameter/minted value. */
export interface NewAuditEntryInput {
  submissionId: string | null;
  playerId: string | null;
  /** `null` for the one system-driven action a human never makes, see
   * `lib/db/schema/audit-log.ts`'s doc comment. */
  actorUserId: string | null;
  action: AuditAction;
  reason: string | null;
}

/**
 * Appends one immutable audit row (card requirement 5). Always a plain
 * insert — there is deliberately no corresponding update/delete export in
 * this module (see module doc comment).
 */
export async function insertAuditEntry(
  campaignId: string,
  input: NewAuditEntryInput,
): Promise<AuditLogEntry> {
  assertCampaignId(campaignId, "insertAuditEntry");
  const [row] = await db
    .insert(auditLog)
    .values({
      campaignId,
      submissionId: input.submissionId,
      playerId: input.playerId,
      actorUserId: input.actorUserId,
      action: input.action,
      reason: input.reason,
    })
    .returning();
  return toDomain(row);
}

/** Lists every audit entry belonging to `campaignId`. Never returns
 * another campaign's rows. */
export async function listAuditEntries(
  campaignId: string,
): Promise<AuditLogEntry[]> {
  assertCampaignId(campaignId, "listAuditEntries");
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.campaignId, campaignId));
  return rows.map(toDomain);
}

/**
 * True if an audit row already exists for `(campaignId, submissionId,
 * action)` (batch-4 review fix, Liotta). Lets a retry-safe caller (e.g.
 * `lib/review/decision.ts`'s already-approved idempotent branch) re-drive
 * the append-audit step without writing a duplicate row for the same
 * decision: the audit log is append-only, so "idempotent" here means
 * "append it if it's missing," not "append it every time."
 */
export async function hasAuditEntry(
  campaignId: string,
  submissionId: string,
  action: AuditAction,
): Promise<boolean> {
  assertCampaignId(campaignId, "hasAuditEntry");
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.campaignId, campaignId),
        eq(auditLog.submissionId, submissionId),
        eq(auditLog.action, action),
      ),
    )
    .limit(1);
  return row !== undefined;
}
