import { z } from 'zod';
import {
  assignmentIdSchema,
  auditLogEntryIdSchema,
  baselineIdSchema,
  calendarExceptionIdSchema,
  calendarIdSchema,
  commentIdSchema,
  dependencyIdSchema,
  durationHoursSchema,
  exportJobIdSchema,
  isoDateSchema,
  isoDateTimeSchema,
  lagHoursSchema,
  mentionIdSchema,
  notificationIdSchema,
  organizationIdSchema,
  percentCompleteSchema,
  prioritySchema,
  projectIdSchema,
  resourceIdSchema,
  taskIdSchema,
  unitsPctSchema,
  userIdSchema,
} from './primitives.js';
import {
  auditActionSchema,
  auditEntityTypeSchema,
  authProviderSchema,
  constraintTypeSchema,
  dependencyTypeSchema,
  exportJobStatusSchema,
  exportTypeSchema,
  notificationTypeSchema,
  planTierSchema,
  projectRoleSchema,
  rateUnitSchema,
  resourceTypeSchema,
  scheduleModeSchema,
  taskStatusSchema,
  weekdaySchema,
} from './enums.js';

/**
 * Persisted entities, one per line of the ERD in `docs/FRS.md` §6.
 *
 * These describe **stored state**, not computed state. CPM outputs (early/late dates, total
 * float, critical-path membership) are deliberately absent: they are derived by
 * `packages/cpm-engine` from this data plus calendars, and modelling them as entity fields
 * invites a second source of truth. They appear in `schedule.ts` as computed projections.
 */

// --------------------------------------------------------------------------------------------
// Organization / identity (FR-AUTH-01..05, FR-PRJ-01)
// --------------------------------------------------------------------------------------------

export const organizationSchema = z.object({
  id: organizationIdSchema,
  name: z.string().min(1).max(200),
  planTier: planTierSchema,
  createdAt: isoDateTimeSchema,
});
export type Organization = z.infer<typeof organizationSchema>;

/**
 * FR-AUTH-01/02/04. No credential material appears here: the password hash lives in a separate
 * table that never leaves `packages/db`, so a `User` can never be accidentally serialised into
 * an API response with a hash attached.
 */
export const userSchema = z.object({
  id: userIdSchema,
  orgId: organizationIdSchema,
  name: z.string().min(1).max(200),
  email: z.string().email(),
  authProvider: authProviderSchema,
  createdAt: isoDateTimeSchema,
});
export type User = z.infer<typeof userSchema>;

// --------------------------------------------------------------------------------------------
// Project (FR-PRJ-02..08, FR-TRK-03)
// --------------------------------------------------------------------------------------------

export const projectSchema = z.object({
  id: projectIdSchema,
  orgId: organizationIdSchema,
  name: z.string().min(1).max(200),
  /** FR-SCH-09: MVP schedules forward from this date. Backward-from-deadline is P2. */
  startDate: isoDateTimeSchema,
  calendarId: calendarIdSchema,
  /** FR-TRK-03. Null until the PM sets one. */
  statusDate: isoDateTimeSchema.nullable(),
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type Project = z.infer<typeof projectSchema>;

/** FR-ACL-01/02, FR-PRJ-06. Membership is per project, so a user holds different roles elsewhere. */
export const projectMemberSchema = z.object({
  projectId: projectIdSchema,
  userId: userIdSchema,
  role: projectRoleSchema,
  invitedAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

// --------------------------------------------------------------------------------------------
// Task (FR-TSK-01..09)
// --------------------------------------------------------------------------------------------

export const taskSchema = z.object({
  id: taskIdSchema,
  projectId: projectIdSchema,
  /** FR-TSK-02: arbitrary depth. Null = top level. */
  parentId: taskIdSchema.nullable(),
  wbsCode: z.string().min(1).max(100),
  name: z.string().min(1).max(500),
  durationHours: durationHoursSchema,
  start: isoDateTimeSchema,
  finish: isoDateTimeSchema,
  pctComplete: percentCompleteSchema,
  /** FR-TSK-04: milestone implies durationHours === 0 and no work assignment. */
  isMilestone: z.boolean(),
  scheduleMode: scheduleModeSchema,
  constraintType: constraintTypeSchema,
  /** FR-TSK-06: required by MSO/MFO/SNET/SNLT/FNET/FNLT, meaningless for ASAP/ALAP. */
  constraintDate: isoDateTimeSchema.nullable(),
  /** FR-TSK-07: null means inherit the project calendar. */
  calendarId: calendarIdSchema.nullable(),
  priority: prioritySchema,
  status: taskStatusSchema,
  /** FR-TRK-03: actuals are independent of scheduled dates. */
  actualStart: isoDateTimeSchema.nullable(),
  actualFinish: isoDateTimeSchema.nullable(),
  /**
   * FR-TSK-01. Snapshot of the collaborative text. FR-COL-03 allows Yjs character-level merge
   * for this field; the Yjs document is a separate artifact (P3) and this column holds the
   * materialised value so the API, exports and reports never need a CRDT runtime to read it.
   */
  notes: z.string(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  updatedBy: userIdSchema,
});
export type Task = z.infer<typeof taskSchema>;

/**
 * FR-TSK-04 / FR-TSK-06 consistency rules that a plain object schema cannot express.
 * Applied at every write boundary (API and, from P2, the scheduler's intent validation).
 */
export const taskInvariantsSchema = taskSchema.superRefine((task, ctx) => {
  if (task.isMilestone && task.durationHours !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['durationHours'],
      message: 'FR-TSK-04: a milestone has duration 0',
    });
  }
  const needsDate = ['MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT'];
  if (needsDate.includes(task.constraintType) && task.constraintDate === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['constraintDate'],
      message: `FR-TSK-06: constraint ${task.constraintType} requires a constraintDate`,
    });
  }
  if (task.parentId !== null && task.parentId === task.id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['parentId'],
      message: 'FR-TSK-02: a task cannot be its own parent',
    });
  }
});

// --------------------------------------------------------------------------------------------
// Dependency (FR-SCH-01..03)
// --------------------------------------------------------------------------------------------

export const dependencySchema = z
  .object({
    id: dependencyIdSchema,
    projectId: projectIdSchema,
    predecessorId: taskIdSchema,
    successorId: taskIdSchema,
    type: dependencyTypeSchema,
    /** FR-SCH-02: signed — negative is lead. */
    lagHours: lagHoursSchema,
    createdAt: isoDateTimeSchema,
  })
  .refine((d) => d.predecessorId !== d.successorId, {
    path: ['successorId'],
    message: 'FR-SCH-03: a task cannot depend on itself (self-cycle)',
  });
export type Dependency = z.infer<typeof dependencySchema>;

// --------------------------------------------------------------------------------------------
// Resources & assignments (FR-RES-01..04, FR-RES-07)
// --------------------------------------------------------------------------------------------

export const resourceSchema = z.object({
  id: resourceIdSchema,
  projectId: projectIdSchema,
  name: z.string().min(1).max(200),
  type: resourceTypeSchema,
  rate: z.number().finite().nonnegative(),
  rateUnit: rateUnitSchema,
  /** FR-RES-02: 100 = 1 FTE, 200 = a two-person pool. */
  maxUnitsPct: unitsPctSchema,
  calendarId: calendarIdSchema.nullable(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const assignmentSchema = z.object({
  id: assignmentIdSchema,
  taskId: taskIdSchema,
  resourceId: resourceIdSchema,
  /** FR-RES-03: independent per assignment (Alice 50%, Bob 100% on the same task). */
  unitsPct: unitsPctSchema,
  /** FR-RES-04: duration x units% x calendar hours, or the driver of duration if effortDriven. */
  workHours: durationHoursSchema,
  cost: z.number().finite().nonnegative(),
  effortDriven: z.boolean(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

// --------------------------------------------------------------------------------------------
// Calendars (FR-CAL-01..04)
// --------------------------------------------------------------------------------------------

export const calendarSchema = z.object({
  id: calendarIdSchema,
  /** Null for an org-level template calendar shared across projects (FR-CAL-04). */
  projectId: projectIdSchema.nullable(),
  name: z.string().min(1).max(200),
  /** ISO weekday numbers, 1 = Monday. */
  workingDays: z.array(weekdaySchema),
  /** Minutes from midnight, so a half-day exception is expressible without a second unit. */
  workingHoursStartMinute: z.number().int().min(0).max(1440),
  workingHoursEndMinute: z.number().int().min(0).max(1440),
  isDefault: z.boolean(),
});
export type Calendar = z.infer<typeof calendarSchema>;

/** FR-CAL-02: overrides the weekly pattern for one date (holiday, half-day). */
export const calendarExceptionSchema = z.object({
  id: calendarExceptionIdSchema,
  calendarId: calendarIdSchema,
  date: isoDateSchema,
  isWorking: z.boolean(),
  workingHoursStartMinuteOverride: z.number().int().min(0).max(1440).nullable(),
  workingHoursEndMinuteOverride: z.number().int().min(0).max(1440).nullable(),
});
export type CalendarException = z.infer<typeof calendarExceptionSchema>;

// --------------------------------------------------------------------------------------------
// Baselines (FR-TRK-01, FR-TRK-02)
// --------------------------------------------------------------------------------------------

/** One task's frozen values inside a baseline snapshot. */
export const baselineTaskSnapshotSchema = z.object({
  taskId: taskIdSchema,
  start: isoDateTimeSchema,
  finish: isoDateTimeSchema,
  durationHours: durationHoursSchema,
  cost: z.number().finite().nonnegative(),
  workHours: durationHoursSchema,
});
export type BaselineTaskSnapshot = z.infer<typeof baselineTaskSnapshotSchema>;

/**
 * FR-TRK-01: JSONB snapshot rather than normalised copies — a baseline is read whole, compared
 * whole, and never edited, so normalising it buys nothing and costs a join per variance query.
 */
export const baselineSchema = z.object({
  id: baselineIdSchema,
  projectId: projectIdSchema,
  name: z.string().min(1).max(200),
  snapshot: z.object({
    capturedAt: isoDateTimeSchema,
    tasks: z.array(baselineTaskSnapshotSchema),
  }),
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type Baseline = z.infer<typeof baselineSchema>;

// --------------------------------------------------------------------------------------------
// Collaboration (FR-COL-05..08)
// --------------------------------------------------------------------------------------------

export const commentSchema = z.object({
  id: commentIdSchema,
  taskId: taskIdSchema,
  userId: userIdSchema,
  body: z.string(),
  /** FR-COL-05: single-level threading is sufficient for MVP. */
  parentCommentId: commentIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Comment = z.infer<typeof commentSchema>;

export const mentionSchema = z.object({
  id: mentionIdSchema,
  commentId: commentIdSchema,
  mentionedUserId: userIdSchema,
  /** FR-COL-06: null until the batched email/in-app notification has gone out. */
  notifiedAt: isoDateTimeSchema.nullable(),
});
export type Mention = z.infer<typeof mentionSchema>;

export const notificationSchema = z.object({
  id: notificationIdSchema,
  userId: userIdSchema,
  type: notificationTypeSchema,
  payload: z.record(z.unknown()),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

/**
 * FR-COL-07. Written at a single choke point in the write path, never from individual handlers —
 * the sprinkled version always develops holes, and invariant 4 makes those holes a correctness
 * bug rather than a missing feature.
 */
export const auditLogEntrySchema = z.object({
  id: auditLogEntryIdSchema,
  projectId: projectIdSchema,
  actorUserId: userIdSchema,
  entityType: auditEntityTypeSchema,
  entityId: z.string().uuid(),
  action: auditActionSchema,
  /** Null on create. */
  before: z.record(z.unknown()).nullable(),
  /** Null on delete. */
  after: z.record(z.unknown()).nullable(),
  createdAt: isoDateTimeSchema,
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

// --------------------------------------------------------------------------------------------
// Export jobs (FR-RPT-04..06)
// --------------------------------------------------------------------------------------------

export const exportJobSchema = z.object({
  id: exportJobIdSchema,
  projectId: projectIdSchema,
  requestedBy: userIdSchema,
  type: exportTypeSchema,
  status: exportJobStatusSchema,
  fileUrl: z.string().url().nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
});
export type ExportJob = z.infer<typeof exportJobSchema>;

/**
 * Registry of every persisted entity in FRS §6. `entities.test.ts` asserts this covers the ERD,
 * so adding a table without adding its contract fails the build rather than drifting quietly.
 */
export const ENTITY_SCHEMAS = {
  Organization: organizationSchema,
  User: userSchema,
  Project: projectSchema,
  ProjectMember: projectMemberSchema,
  Task: taskSchema,
  Dependency: dependencySchema,
  Resource: resourceSchema,
  Assignment: assignmentSchema,
  Calendar: calendarSchema,
  CalendarException: calendarExceptionSchema,
  Baseline: baselineSchema,
  Comment: commentSchema,
  Mention: mentionSchema,
  Notification: notificationSchema,
  AuditLogEntry: auditLogEntrySchema,
  ExportJob: exportJobSchema,
} as const;

export type EntityName = keyof typeof ENTITY_SCHEMAS;
