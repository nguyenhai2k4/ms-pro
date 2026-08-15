import type { SqlExecutor } from '@projectapp/db';
import type { AuditAction, AuditEntityType } from '@projectapp/shared-types';

/**
 * Invariant 4 / FR-COL-07: every schedule-affecting mutation writes an audit entry with
 * before/after.
 *
 * This is a **choke point**, not a helper. The intended usage is `auditedMutation(...)` wrapping
 * the write, so the audit row and the change are one transaction and cannot come apart. Calling
 * `writeAuditEntry` directly from a handler is possible but is the pattern that develops holes:
 * the handler that forgets it still compiles, still passes its own test, and silently produces an
 * activity feed with gaps that nobody notices until an audit is requested.
 *
 * `apps/scheduler` will need the same guarantee for mutations it applies (P2/P3). When that lands
 * it uses this module rather than growing a second implementation.
 */

export interface AuditContext {
  readonly projectId: string;
  readonly actorUserId: string;
}

export interface AuditRecord {
  readonly entityType: AuditEntityType;
  readonly entityId: string;
  readonly action: AuditAction;
  /** Required for update/delete, must be absent for create — the database enforces this too. */
  readonly before?: Record<string, unknown> | null;
  /** Required for create/update, must be absent for delete. */
  readonly after?: Record<string, unknown> | null;
}

export async function writeAuditEntry(
  exec: SqlExecutor,
  context: AuditContext,
  record: AuditRecord,
): Promise<void> {
  await exec.query(
    `INSERT INTO audit_log_entry
       (project_id, actor_user_id, entity_type, entity_id, action, before_json, after_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      context.projectId,
      context.actorUserId,
      record.entityType,
      record.entityId,
      record.action,
      record.before === undefined || record.before === null ? null : JSON.stringify(record.before),
      record.after === undefined || record.after === null ? null : JSON.stringify(record.after),
    ],
  );
}

/**
 * Runs `mutate` and records what it did, in a single transaction. If the audit write fails, the
 * mutation is rolled back — an unauditable change is not an acceptable outcome under invariant 4,
 * and the alternative (commit the change, log the audit failure) is exactly how a gap appears.
 */
export async function auditedMutation<T>(
  exec: SqlExecutor,
  context: AuditContext,
  mutate: () => Promise<{ result: T; audit: AuditRecord | AuditRecord[] }>,
): Promise<T> {
  await exec.exec('BEGIN');
  try {
    const { result, audit } = await mutate();
    for (const record of Array.isArray(audit) ? audit : [audit]) {
      await writeAuditEntry(exec, context, record);
    }
    await exec.exec('COMMIT');
    return result;
  } catch (error) {
    await exec.exec('ROLLBACK');
    throw error;
  }
}
