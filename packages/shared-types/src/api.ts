import { z } from 'zod';
import { calendarTemplateSchema, projectRoleSchema } from './enums.js';
import { organizationSchema, projectSchema, userSchema } from './entities.js';
import { isoDateTimeSchema, projectIdSchema, userIdSchema } from './primitives.js';

/**
 * REST surface for P0: authentication (FR-AUTH) and the organization/project shell (FR-PRJ).
 *
 * Scope note: task, dependency, resource, calendar and reporting endpoints are **not** here.
 * They belong to P1 and later, and writing their DTOs now — before the entities they operate on
 * have been through an implementation — produces contracts that get rewritten rather than built
 * against. This file grows one phase at a time.
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
