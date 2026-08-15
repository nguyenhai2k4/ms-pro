import { z } from 'zod';
import { constraintTypeSchema, scheduleModeSchema, taskStatusSchema } from './enums.js';
import {
  calendarIdSchema,
  durationHoursSchema,
  isoDateTimeSchema,
  percentCompleteSchema,
  prioritySchema,
  projectIdSchema,
  taskIdSchema,
  userIdSchema,
} from './primitives.js';

/**
 * The mutation-intent envelope (ADR-002, pulled to P1 entry by ADR-007).
 *
 * `apps/api` never computes or writes a task's `start`/`finish`/rollup fields itself — invariant
 * 2 in `CLAUDE.md`. It turns a validated HTTP request into one of the intents below and hands it
 * to the in-process scheduler (`apps/api/src/scheduler`), which is the only code path allowed to
 * write those columns. In P2 the same intents move to the standalone Scheduler Service without
 * changing shape; callers do not change (ADR-007).
 *
 * Scope: P1's writer is one HTTP request at a time, and there are no realtime clients yet
 * (P3 introduces concurrent WebSocket-driven mutation). ADR-007 leaves open whether the
 * ADR-002 single-writer per-project queue is needed in P1; the answer is no — a per-request
 * Postgres transaction already serialises conflicting writes to the same rows, and there is no
 * concurrent in-process consumer yet to order. `applyTaskIntent` (the scheduler's single entry
 * point) is deliberately shaped so a queue can sit in front of it at P3 entry without changing
 * this envelope or any caller — see `apps/api/src/scheduler/rollup.ts`.
 *
 * These describe *what the user asked for*, not what an engine computes (ADR-007's bound on
 * scope creep). P1's intents are create/update/reparent/delete a task — a subset of the eventual
 * P2 set (which adds dependency and constraint-driven shifts). Widening this later is additive;
 * if it turns out to be structural, that is a superseding ADR, not a quiet edit here.
 */

const baseTaskFieldsSchema = z.object({
  name: z.string().min(1).max(500),
  durationHours: durationHoursSchema,
  /** FR-TSK-01: caller-supplied only for a manually-scheduled task; ignored otherwise. */
  start: isoDateTimeSchema.nullable(),
  isMilestone: z.boolean(),
  scheduleMode: scheduleModeSchema,
  constraintType: constraintTypeSchema,
  constraintDate: isoDateTimeSchema.nullable(),
  calendarId: calendarIdSchema.nullable(),
  priority: prioritySchema,
});

/** FR-TSK-01, FR-TSK-02, FR-TSK-04. `parentId: null` creates a top-level task. */
export const createTaskIntentSchema = baseTaskFieldsSchema
  .extend({
    kind: z.literal('createTask'),
    projectId: projectIdSchema,
    parentId: taskIdSchema.nullable(),
  })
  .strict();
export type CreateTaskIntent = z.infer<typeof createTaskIntentSchema>;

/**
 * FR-TSK-01, FR-TSK-05, FR-TSK-06, FR-TSK-07, FR-TRK-04. Every scheduling field is optional —
 * only the fields present are changed. Non-scheduling fields (`pctComplete`, `actualStart`,
 * `actualFinish`, `notes`, `status`) travel through this same intent so there remains exactly one
 * write path per invariant 2, even though a Contributor's request touches none of the fields
 * above (`packages/shared-types/src/rbac.ts` `CONTRIBUTOR_WRITABLE_TASK_FIELDS` is enforced by
 * the caller before the intent is built, not by this schema, since the writable-field set is a
 * function of role, not of shape).
 */
export const updateTaskIntentSchema = baseTaskFieldsSchema
  .partial()
  .extend({
    kind: z.literal('updateTask'),
    taskId: taskIdSchema,
    pctComplete: percentCompleteSchema.optional(),
    actualStart: isoDateTimeSchema.nullable().optional(),
    actualFinish: isoDateTimeSchema.nullable().optional(),
    notes: z.string().optional(),
    status: taskStatusSchema.optional(),
  })
  .strict();
export type UpdateTaskIntent = z.infer<typeof updateTaskIntentSchema>;

/**
 * FR-TSK-02: move a task to a new parent (or to top level). Distinct from `updateTask` because a
 * reparent changes WBS position for the whole moved subtree and triggers rollup on both the old
 * and new ancestor chains — two different blast radii that a single generic "patch" intent would
 * blur.
 */
export const reparentTaskIntentSchema = z
  .object({
    kind: z.literal('reparentTask'),
    taskId: taskIdSchema,
    newParentId: taskIdSchema.nullable(),
    /** Position among the new parent's children; append when omitted. */
    newIndex: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ReparentTaskIntent = z.infer<typeof reparentTaskIntentSchema>;

/**
 * FR-TSK-08: deleting a task with children requires an explicit, user-chosen policy — there is
 * no default, because guessing here is exactly the silent-data-loss failure mode the requirement
 * exists to prevent. FR-TSK-09: successor/predecessor dependencies on the deleted task are
 * removed as part of the same intent (a no-op in P1, since dependencies do not exist until P2).
 */
export const deleteTaskChildPolicySchema = z.enum(['cascade', 'reparentToGrandparent']);
export type DeleteTaskChildPolicy = z.infer<typeof deleteTaskChildPolicySchema>;

export const deleteTaskIntentSchema = z
  .object({
    kind: z.literal('deleteTask'),
    taskId: taskIdSchema,
    /** Required only when the task has children; validated against actual children server-side. */
    childPolicy: deleteTaskChildPolicySchema.optional(),
  })
  .strict();
export type DeleteTaskIntent = z.infer<typeof deleteTaskIntentSchema>;

export const taskIntentSchema = z
  .discriminatedUnion('kind', [
    createTaskIntentSchema,
    updateTaskIntentSchema,
    reparentTaskIntentSchema,
    deleteTaskIntentSchema,
  ])
  .superRefine((intent, ctx) => {
    if (intent.kind !== 'updateTask') return;
    const hasChange = Object.keys(intent).some((key) => key !== 'kind' && key !== 'taskId');
    if (!hasChange) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no fields to update' });
    }
  });
export type TaskIntent = z.infer<typeof taskIntentSchema>;

/**
 * What travels from `apps/api` to the scheduler. `issuedAt` is the API's clock, not a client
 * timestamp — never trust a caller's notion of "when," per the same reasoning that keeps `Date`
 * off the wire (`primitives.ts`).
 */
export const mutationIntentEnvelopeSchema = z.object({
  intent: taskIntentSchema,
  projectId: projectIdSchema,
  actorUserId: userIdSchema,
  issuedAt: isoDateTimeSchema,
});
export type MutationIntentEnvelope = z.infer<typeof mutationIntentEnvelopeSchema>;
