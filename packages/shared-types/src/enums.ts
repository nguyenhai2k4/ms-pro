import { z } from 'zod';

/**
 * Closed vocabularies. Every one of these is duplicated as a Postgres enum or check constraint
 * in `packages/db`; the test suite there asserts the two lists match, because a value that
 * parses in TypeScript and fails on insert is a runtime-only bug.
 */

/** FR-ACL-01, FRS §2. Project-scoped, not org-scoped (FR-ACL-02). */
export const projectRoleSchema = z.enum(['admin', 'editor', 'contributor', 'viewer']);
export type ProjectRole = z.infer<typeof projectRoleSchema>;

/** FR-SCH-01. */
export const dependencyTypeSchema = z.enum(['FS', 'SS', 'FF', 'SF']);
export type DependencyType = z.infer<typeof dependencyTypeSchema>;

/** FR-TSK-06. */
export const constraintTypeSchema = z.enum([
  'ASAP',
  'ALAP',
  'MSO',
  'MFO',
  'SNET',
  'SNLT',
  'FNET',
  'FNLT',
]);
export type ConstraintType = z.infer<typeof constraintTypeSchema>;

/** FR-TSK-05. */
export const scheduleModeSchema = z.enum(['auto', 'manual']);
export type ScheduleMode = z.infer<typeof scheduleModeSchema>;

/** FR-RES-01. */
export const resourceTypeSchema = z.enum(['work', 'material', 'cost']);
export type ResourceType = z.infer<typeof resourceTypeSchema>;

/** FR-RES-02. */
export const rateUnitSchema = z.enum(['hour', 'use']);
export type RateUnit = z.infer<typeof rateUnitSchema>;

/**
 * Task workflow status. Contract decision: this is the Kanban column key (FR-VIEW-06) and is
 * deliberately **independent of scheduling dates** — FR-VIEW-06 states dragging a card must not
 * move dates unless explicitly mapped. Keeping status out of the CPM input is what makes that
 * true structurally rather than by convention.
 */
export const taskStatusSchema = z.enum(['not_started', 'in_progress', 'blocked', 'done']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** FR-AUTH-01, FR-AUTH-02. */
export const authProviderSchema = z.enum(['password', 'google', 'microsoft']);
export type AuthProvider = z.infer<typeof authProviderSchema>;

/** FR-CAL-04. Deliberately a short list for MVP. */
export const calendarTemplateSchema = z.enum(['mon_fri', 'us']);
export type CalendarTemplate = z.infer<typeof calendarTemplateSchema>;

/**
 * FR-COL-07. Exactly the entity set the FRS requires audited — extend the FRS before this.
 * `calendar` added at P1 entry: FR-CAL-01..04 CRUD is schedule-affecting and invariant 4
 * (CLAUDE.md) requires it audited; 0001_init.sql did not anticipate P1's calendar mutations.
 */
export const auditEntityTypeSchema = z.enum([
  'task',
  'dependency',
  'resource',
  'assignment',
  'baseline',
  'project_member',
  'project',
  'calendar',
]);
export type AuditEntityType = z.infer<typeof auditEntityTypeSchema>;

export const auditActionSchema = z.enum(['create', 'update', 'delete']);
export type AuditAction = z.infer<typeof auditActionSchema>;

/** FR-RPT-04..06. */
export const exportTypeSchema = z.enum(['pdf', 'png', 'xlsx', 'csv', 'json']);
export type ExportType = z.infer<typeof exportTypeSchema>;

export const exportJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type ExportJobStatus = z.infer<typeof exportJobStatusSchema>;

/** FR-COL-05, FR-COL-06. */
export const notificationTypeSchema = z.enum(['mention', 'comment_reply', 'role_changed']);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const planTierSchema = z.enum(['free', 'pro', 'enterprise']);
export type PlanTier = z.infer<typeof planTierSchema>;

/** ISO-8601 weekday numbering: 1 = Monday .. 7 = Sunday (FR-CAL-01 working days). */
export const weekdaySchema = z.number().int().min(1).max(7);
export type Weekday = z.infer<typeof weekdaySchema>;
