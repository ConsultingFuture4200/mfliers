/**
 * Audit log — domain module (T4.2, card "Files to Create/Modify":
 * `lib/audit/log.ts`). PRD FR-R1…FR-R4 / constitution §5: "immutable,
 * append-only log of all approvals, rejections, manual adjustments,
 * settlements, and claim events." Thin wrapper over
 * `lib/db/dal/audit-log.ts` (constitution §6: domain logic in `lib/`; the
 * DAL is the raw-DB-access boundary the ESLint `no-restricted-imports`
 * rule requires every other `lib/` module to go through).
 *
 * `lib/review/decision.ts` (this card's approve/reject/adjust
 * orchestration) is the sole caller today; kept as its own module (rather
 * than folded into `decision.ts`) since a future card may want to log a
 * non-review event here too (e.g. a claim event) without importing review
 * logic to do it.
 */
import {
  hasAuditEntry,
  insertAuditEntry,
  listAuditEntries,
} from "@/lib/db/dal/audit-log";
import type { AuditAction, AuditLogEntry } from "@/types/domain";

/** Input to `appendAuditEntry`. `campaignId` is threaded separately (as
 * the DAL's required first parameter) rather than folded into this shape,
 * matching every other DAL-backed domain function in this codebase
 * (`lib/campaign/lifecycle.ts`, `lib/target/state-machine.ts`, ...). */
export interface AuditEntryInput {
  submissionId?: string | null;
  playerId?: string | null;
  /** `null` for a system-driven action (e.g. the auto-approve pipeline
   * dispatch) that no staff user decided, see
   * `lib/db/schema/audit-log.ts`'s doc comment. */
  actorUserId: string | null;
  action: AuditAction;
  reason?: string | null;
}

/**
 * Appends one immutable audit row (card requirement 5: "every
 * approve/reject/adjustment writes an immutable, append-only audit
 * entry"). Never mutates or deletes a prior entry — there is no
 * update/delete export anywhere in this module or the DAL it wraps.
 */
export async function appendAuditEntry(
  campaignId: string,
  input: AuditEntryInput,
): Promise<AuditLogEntry> {
  return insertAuditEntry(campaignId, {
    submissionId: input.submissionId ?? null,
    playerId: input.playerId ?? null,
    actorUserId: input.actorUserId,
    action: input.action,
    reason: input.reason ?? null,
  });
}

/** Lists `campaignId`'s full audit trail. Host-scoped callers must call
 * `requireCampaignAccess` before this (this module has no opinion on
 * authorization — see `lib/review/decision.ts`/the route handler). */
export async function listAuditLog(
  campaignId: string,
): Promise<AuditLogEntry[]> {
  return listAuditEntries(campaignId);
}

/**
 * True if an audit row already exists for `(campaignId, submissionId,
 * action)`. See `lib/db/dal/audit-log.ts`'s `hasAuditEntry` doc comment;
 * lets a retry-safe caller re-drive "append the audit row" without
 * double-writing on a decision that was already fully recorded.
 */
export async function auditEntryExists(
  campaignId: string,
  submissionId: string,
  action: AuditAction,
): Promise<boolean> {
  return hasAuditEntry(campaignId, submissionId, action);
}
