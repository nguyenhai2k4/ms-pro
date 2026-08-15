import { z } from 'zod';

/**
 * Scalar contract decisions. These are small and they are load-bearing — every package encodes
 * them, so changing one later is a cross-package migration, not an edit.
 *
 * 1. **Identifiers are UUID strings, branded per entity.** Branding is compile-time only (zero
 *    runtime cost) and stops the class of bug where a `ResourceId` is passed where a `TaskId`
 *    belongs — which in a graph algorithm produces a plausible-looking wrong schedule rather
 *    than a crash.
 *
 * 2. **Instants on the wire are ISO-8601 UTC strings, never `Date` objects.** Three reasons:
 *    `Date` does not survive JSON (REST responses, WebSocket deltas, JSONB baseline snapshots);
 *    a `Date` carries an implicit local-timezone reading that would make CPM output depend on
 *    the machine that ran it, violating invariant 1 (same input -> byte-identical output); and
 *    `zod`'s `.datetime()` with no offset allowance forces the `Z` suffix, so "which timezone
 *    is this" never becomes a question at a package boundary.
 *
 * 3. **Duration and lag are hours**, matching `duration_hours` / `lag_hours` in FRS §6.
 *    Calendars convert hours to wall-clock dates (FR-SCH-07); no other unit crosses a boundary.
 *
 * 4. **Wire and TS are camelCase; Postgres columns are snake_case.** The mapping lives in
 *    `packages/db` and nowhere else. Any camelCase in SQL or snake_case in a DTO is a leak.
 */

export const uuidSchema = z.string().uuid();

export const organizationIdSchema = uuidSchema.brand<'OrganizationId'>();
export type OrganizationId = z.infer<typeof organizationIdSchema>;

export const userIdSchema = uuidSchema.brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

export const projectIdSchema = uuidSchema.brand<'ProjectId'>();
export type ProjectId = z.infer<typeof projectIdSchema>;

export const taskIdSchema = uuidSchema.brand<'TaskId'>();
export type TaskId = z.infer<typeof taskIdSchema>;

export const dependencyIdSchema = uuidSchema.brand<'DependencyId'>();
export type DependencyId = z.infer<typeof dependencyIdSchema>;

export const resourceIdSchema = uuidSchema.brand<'ResourceId'>();
export type ResourceId = z.infer<typeof resourceIdSchema>;

export const assignmentIdSchema = uuidSchema.brand<'AssignmentId'>();
export type AssignmentId = z.infer<typeof assignmentIdSchema>;

export const calendarIdSchema = uuidSchema.brand<'CalendarId'>();
export type CalendarId = z.infer<typeof calendarIdSchema>;

export const calendarExceptionIdSchema = uuidSchema.brand<'CalendarExceptionId'>();
export type CalendarExceptionId = z.infer<typeof calendarExceptionIdSchema>;

export const baselineIdSchema = uuidSchema.brand<'BaselineId'>();
export type BaselineId = z.infer<typeof baselineIdSchema>;

export const commentIdSchema = uuidSchema.brand<'CommentId'>();
export type CommentId = z.infer<typeof commentIdSchema>;

export const mentionIdSchema = uuidSchema.brand<'MentionId'>();
export type MentionId = z.infer<typeof mentionIdSchema>;

export const notificationIdSchema = uuidSchema.brand<'NotificationId'>();
export type NotificationId = z.infer<typeof notificationIdSchema>;

export const auditLogEntryIdSchema = uuidSchema.brand<'AuditLogEntryId'>();
export type AuditLogEntryId = z.infer<typeof auditLogEntryIdSchema>;

export const exportJobIdSchema = uuidSchema.brand<'ExportJobId'>();
export type ExportJobId = z.infer<typeof exportJobIdSchema>;

/** ISO-8601 instant, UTC, `Z`-suffixed. e.g. `2026-09-01T08:00:00.000Z`. */
export const isoDateTimeSchema = z.string().datetime();
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

/** Calendar date with no time component, e.g. `2026-12-25`. Used for calendar exceptions. */
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = z.infer<typeof isoDateSchema>;

/** Non-negative hours. Milestones are 0 (FR-TSK-04). */
export const durationHoursSchema = z.number().finite().nonnegative();

/** Signed hours — negative lag is lead, and it is a real case the CPM suite must cover (FR-SCH-02). */
export const lagHoursSchema = z.number().finite();

/** 0-100 inclusive. Not an integer: duration-weighted rollup (FR-TSK-03) produces fractions. */
export const percentCompleteSchema = z.number().min(0).max(100);

/**
 * Allocation percentage. 100 = one full-time unit; 200 = two (FR-RES-02 max units, FR-RES-03
 * per-assignment units). Unbounded above because a resource can model a pool.
 */
export const unitsPctSchema = z.number().finite().nonnegative();

/**
 * Task priority, driving leveling order (FR-RES-06: priority first, then late-start-first).
 *
 * Contract decision: 0-1000 with 500 as the default, matching the convention PMs arriving from
 * MS Project already have. Higher number = more important = leveled last. Leveling is
 * deterministic (ADR-005), so ties must break on a stable field, never on insertion order.
 */
export const prioritySchema = z.number().int().min(0).max(1000);
export const DEFAULT_PRIORITY = 500;
