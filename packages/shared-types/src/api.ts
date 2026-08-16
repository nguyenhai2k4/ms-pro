import { z } from 'zod';
import {
  constraintTypeSchema,
  calendarTemplateSchema,
  dependencyTypeSchema,
  projectRoleSchema,
  scheduleModeSchema,
  taskStatusSchema,
  weekdaySchema,
} from './enums.js';
import {
  calendarSchema,
  calendarExceptionSchema,
  dependencySchema,
  organizationSchema,
  projectSchema,
  taskSchema,
  userSchema,
} from './entities.js';
import { cpmDiagnosticSchema } from './cpm.js';
import { deleteTaskChildPolicySchema } from './intents.js';
import { taskScheduleComputedSchema } from './schedule.js';
import {
  calendarExceptionIdSchema,
  calendarIdSchema,
  dependencyIdSchema,
  durationHoursSchema,
  isoDateSchema,
  isoDateTimeSchema,
  lagHoursSchema,
  percentCompleteSchema,
  prioritySchema,
  projectIdSchema,
  taskIdSchema,
  userIdSchema,
} from './primitives.js';

/**
 * REST surface for P0 (authentication, org/project shell) and P1 (task/WBS, calendars).
 *
 * Scope note: dependency, resource and reporting endpoints are **not** here. They belong to P2
 * and later, and writing their DTOs now — before the entities they operate on have been through
 * an implementation — produces contracts that get rewritten rather than built against. This file
 * grows one phase at a time.
 */

// --------------------------------------------------------------------------------------------
// Auth (FR-AUTH-01..05)
// --------------------------------------------------------------------------------------------

/**
 * FR-AUTH-01. The minimum length is a contract-level floor, not a UI hint: the API rejects short
 * passwords regardless of what any client validates.
 */
export const passwordSchema = z.string().min(12).max(256);

export const registerRequestSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: passwordSchema,
  /** FR-PRJ-01: names the organization created alongside the first user. */
  organizationName: z.string().min(1).max(200),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * FR-AUTH-03. The token carries identity only — no roles. Roles are re-read per request from
 * `ProjectMember` (FR-AUTH-06), which is what makes a revoked role take effect on a live session
 * immediately (UC-10) instead of at next login.
 */
export const sessionSchema = z.object({
  token: z.string(),
  expiresAt: isoDateTimeSchema,
  user: userSchema,
  organization: organizationSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const currentUserResponseSchema = z.object({
  user: userSchema,
  organization: organizationSchema,
});
export type CurrentUserResponse = z.infer<typeof currentUserResponseSchema>;

/** FR-AUTH-05. Always answered 202 regardless of whether the address exists (no enumeration). */
export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>;

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});
export type PasswordResetConfirm = z.infer<typeof passwordResetConfirmSchema>;

// --------------------------------------------------------------------------------------------
// Project shell (FR-PRJ-02..08)
// --------------------------------------------------------------------------------------------

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: isoDateTimeSchema,
  /** FR-CAL-04 / UC-1 error flow: an unknown template falls back to `mon_fri` rather than failing. */
  calendarTemplate: calendarTemplateSchema.default('mon_fri'),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

/** FR-PRJ-03: the caller's own role travels with the summary so the client never guesses it. */
export const projectSummarySchema = z.object({
  project: projectSchema,
  role: projectRoleSchema,
  taskCount: z.number().int().nonnegative(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    startDate: isoDateTimeSchema.optional(),
    statusDate: isoDateTimeSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

/**
 * FR-PRJ-05: deletion requires the caller to retype the project name. A destructive irreversible
 * action guarded only by a role check is one misclick from a support incident.
 */
export const deleteProjectRequestSchema = z.object({
  confirmName: z.string().min(1),
});
export type DeleteProjectRequest = z.infer<typeof deleteProjectRequestSchema>;

/** FR-PRJ-06 / UC-10. */
export const inviteMemberRequestSchema = z.object({
  email: z.string().email(),
  role: projectRoleSchema,
});
export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;

export const updateMemberRoleRequestSchema = z.object({
  role: projectRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>;

export const projectMemberViewSchema = z.object({
  projectId: projectIdSchema,
  userId: userIdSchema,
  name: z.string(),
  email: z.string().email(),
  role: projectRoleSchema,
  invitedAt: isoDateTimeSchema,
  acceptedAt: isoDateTimeSchema.nullable(),
});
export type ProjectMemberView = z.infer<typeof projectMemberViewSchema>;

// --------------------------------------------------------------------------------------------
// Task & WBS (FR-TSK-01..09). `projectId` travels in the URL, not the body, on every one of
// these — REST convention here, and it means the intent-envelope's `projectId` (`intents.ts`)
// always comes from a validated route param rather than a client-supplied body field.
// --------------------------------------------------------------------------------------------

/** FR-TSK-01, FR-TSK-02, FR-TSK-04. `parentId: null` creates a top-level task. */
export const createTaskRequestSchema = z.object({
  parentId: taskIdSchema.nullable(),
  name: z.string().min(1).max(500),
  durationHours: durationHoursSchema,
  /** Only meaningful when `scheduleMode` is `manual`; the scheduler sets it otherwise. */
  start: isoDateTimeSchema.nullable(),
  isMilestone: z.boolean().default(false),
  scheduleMode: scheduleModeSchema.default('auto'),
  constraintType: constraintTypeSchema.default('ASAP'),
  constraintDate: isoDateTimeSchema.nullable().default(null),
  calendarId: calendarIdSchema.nullable().default(null),
  priority: prioritySchema.default(500),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/**
 * FR-TSK-01, FR-TSK-05, FR-TSK-06, FR-TSK-07, FR-TRK-04. Partial: only supplied fields change.
 * The handler still enforces `CONTRIBUTOR_WRITABLE_TASK_FIELDS` (`rbac.ts`) against whichever
 * keys are present before it becomes an `UpdateTaskIntent` — this DTO does not itself narrow by
 * role, since the writable set depends on the caller, not the shape of a PATCH.
 */
export const updateTaskRequestSchema = z
  .object({
    name: z.string().min(1).max(500).optional(),
    durationHours: durationHoursSchema.optional(),
    start: isoDateTimeSchema.nullable().optional(),
    isMilestone: z.boolean().optional(),
    scheduleMode: scheduleModeSchema.optional(),
    constraintType: constraintTypeSchema.optional(),
    constraintDate: isoDateTimeSchema.nullable().optional(),
    calendarId: calendarIdSchema.nullable().optional(),
    priority: prioritySchema.optional(),
    pctComplete: percentCompleteSchema.optional(),
    actualStart: isoDateTimeSchema.nullable().optional(),
    actualFinish: isoDateTimeSchema.nullable().optional(),
    notes: z.string().optional(),
    // `taskStatusSchema`, not a second inline copy of the same four values: `packages/db`'s
    // schema test pins the database enum against `enums.ts` only, so a re-listed vocabulary here
    // would drift out of both without failing anything.
    status: taskStatusSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

/** FR-TSK-02: move a task to a new parent (or to top level) and/or position among siblings. */
export const reparentTaskRequestSchema = z.object({
  newParentId: taskIdSchema.nullable(),
  newIndex: z.number().int().nonnegative().optional(),
});
export type ReparentTaskRequest = z.infer<typeof reparentTaskRequestSchema>;

/**
 * FR-TSK-08: required (`validationFailed`) when the task has children; rejected with `conflict`
 * when supplied for a childless task, so the two error paths in the requirement's "explicit
 * confirmation" language are distinguishable by the client without inspecting the task first.
 */
export const deleteTaskRequestSchema = z.object({
  childPolicy: deleteTaskChildPolicySchema.optional(),
});
export type DeleteTaskRequest = z.infer<typeof deleteTaskRequestSchema>;

export const taskResponseSchema = z.object({ task: taskSchema });
export type TaskResponse = z.infer<typeof taskResponseSchema>;

/** FR-TSK-02, FR-VIEW-03: the full project tree, flat with `parentId`; the client builds hierarchy. */
export const taskListResponseSchema = z.object({ tasks: z.array(taskSchema) });
export type TaskListResponse = z.infer<typeof taskListResponseSchema>;

// --------------------------------------------------------------------------------------------
// Calendars (FR-CAL-01..04)
// --------------------------------------------------------------------------------------------

/** FR-CAL-03: an additional named calendar in the project (e.g. one resource's PTO calendar). */
export const createCalendarRequestSchema = z.object({
  name: z.string().min(1).max(200),
  workingDays: z.array(weekdaySchema).min(1),
  workingHoursStartMinute: z.number().int().min(0).max(1440),
  workingHoursEndMinute: z.number().int().min(0).max(1440),
});
export type CreateCalendarRequest = z.infer<typeof createCalendarRequestSchema>;

/**
 * FR-CAL-01: editing the project's own calendar (working days/hours) goes through this endpoint
 * too — it is the same entity, not a special case. Swapping which calendar is the project
 * *default* is a `project:update` (`startDate`/`calendarId` on `Project`), not a field here.
 */
export const updateCalendarRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    workingDays: z.array(weekdaySchema).min(1).optional(),
    workingHoursStartMinute: z.number().int().min(0).max(1440).optional(),
    workingHoursEndMinute: z.number().int().min(0).max(1440).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'no fields to update' });
export type UpdateCalendarRequest = z.infer<typeof updateCalendarRequestSchema>;

/** FR-CAL-02: a single date's override; `isWorking: false` is a holiday, `true` with hours is a half-day. */
export const createCalendarExceptionRequestSchema = z.object({
  date: isoDateSchema,
  isWorking: z.boolean(),
  workingHoursStartMinuteOverride: z.number().int().min(0).max(1440).nullable().default(null),
  workingHoursEndMinuteOverride: z.number().int().min(0).max(1440).nullable().default(null),
});
export type CreateCalendarExceptionRequest = z.infer<typeof createCalendarExceptionRequestSchema>;

export const calendarExceptionIdParamSchema = z.object({ exceptionId: calendarExceptionIdSchema });

export const calendarExceptionResponseSchema = z.object({ exception: calendarExceptionSchema });
export type CalendarExceptionResponse = z.infer<typeof calendarExceptionResponseSchema>;

export const calendarResponseSchema = z.object({
  calendar: calendarSchema,
  exceptions: z.array(calendarExceptionSchema),
});
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

/** FR-CAL-03: every calendar in the project, including the default and any resource/task overrides. */
export const calendarListResponseSchema = z.object({ calendars: z.array(calendarSchema) });
export type CalendarListResponse = z.infer<typeof calendarListResponseSchema>;

// --------------------------------------------------------------------------------------------
// Dependencies & computed schedule (FR-SCH-01..05, FR-SCH-10) — added at P2 entry
// --------------------------------------------------------------------------------------------

/**
 * FR-SCH-01, FR-SCH-02. `projectId` travels in the URL like every other project-scoped route;
 * both task ids are validated to belong to it server-side (FR-SCH-01 is same-project only, and
 * FR-AUTH-04 requires a cross-project id to look like absence rather than like a permission error).
 */
export const createDependencyRequestSchema = z.object({
  predecessorId: taskIdSchema,
  successorId: taskIdSchema,
  type: dependencyTypeSchema,
  /** FR-SCH-02: signed working hours. Negative is lead. Defaulted so the common case is a bare link. */
  lagHours: lagHoursSchema.default(0),
});
export type CreateDependencyRequest = z.infer<typeof createDependencyRequestSchema>;

/** Retype or re-lag. Changing the endpoints is a delete plus a create — see `intents.ts`. */
export const updateDependencyRequestSchema = z
  .object({
    type: dependencyTypeSchema.optional(),
    lagHours: lagHoursSchema.optional(),
  })
  .refine((body) => body.type !== undefined || body.lagHours !== undefined, {
    message: 'no fields to update',
  });
export type UpdateDependencyRequest = z.infer<typeof updateDependencyRequestSchema>;

export const dependencyIdParamSchema = z.object({ dependencyId: dependencyIdSchema });

export const dependencyResponseSchema = z.object({ dependency: dependencySchema });
export type DependencyResponse = z.infer<typeof dependencyResponseSchema>;

export const dependencyListResponseSchema = z.object({
  dependencies: z.array(dependencySchema),
});
export type DependencyListResponse = z.infer<typeof dependencyListResponseSchema>;

/**
 * FR-SCH-03. The body of a `dependency_cycle` error (`http.ts` reserved the code and the
 * `details.cyclePath` field in P0). Typed here so the client can render "A -> B -> C -> A" and
 * highlight the offending arrows instead of showing a generic 409.
 */
export const dependencyCycleDetailsSchema = z.object({
  cyclePath: z.array(taskIdSchema).min(2),
  cycleDependencyIds: z.array(dependencyIdSchema).min(1),
});
export type DependencyCycleDetails = z.infer<typeof dependencyCycleDetailsSchema>;

/**
 * FR-SCH-04, FR-SCH-05, FR-SCH-10. The engine-derived analysis for a project, read-only: there is
 * no PATCH counterpart and there never will be one, because float that can be set by hand is not
 * float (`schedule.ts`). Served alongside `taskListResponseSchema` rather than merged into it so
 * that the read-only-ness is visible in the URL, not just in a comment.
 *
 * `criticalDependencyIds` populates `GanttDependencyView.isCritical`, which has been in the Gantt
 * contract since P0 with no data source until now.
 */
export const projectScheduleResponseSchema = z.object({
  schedules: z.array(taskScheduleComputedSchema),
  criticalDependencyIds: z.array(dependencyIdSchema),
  projectFinish: isoDateTimeSchema,
  /**
   * FR-SCH-08 / FR-TSK-06 warnings the user needs to see. Error-severity diagnostics never reach
   * this endpoint: they reject the mutation that caused them, so a stored schedule cannot hold one.
   */
  diagnostics: z.array(cpmDiagnosticSchema),
});
export type ProjectScheduleResponse = z.infer<typeof projectScheduleResponseSchema>;
