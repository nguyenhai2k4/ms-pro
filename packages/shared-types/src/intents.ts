import { z } from 'zod';
import {
  constraintTypeSchema,
  dependencyTypeSchema,
  scheduleModeSchema,
  taskStatusSchema,
} from './enums.js';
import {
  calendarIdSchema,
  dependencyIdSchema,
  durationHoursSchema,
  isoDateTimeSchema,
  lagHoursSchema,
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
 * concurrent in-process consumer yet to order. `applyScheduleIntent` (the scheduler's single entry
 * point) is deliberately shaped so a queue can sit in front of it at P3 entry without changing
 * this envelope or any caller — see `apps/api/src/scheduler/rollup.ts`.
 *
 * These describe *what the user asked for*, not what an engine computes (ADR-007's bound on
 * scope creep). P1's intents were create/update/reparent/delete a task; P2 widened the set with
 * the dependency intents below (contract 0.4.0). Widening it again is additive; if it turns out to
 * be structural, that is a superseding ADR, not a quiet edit here.
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

// ---------------------------------------------------------------------------------------------
// Dependency intents (P2 — FR-SCH-01, FR-SCH-02, FR-SCH-03)
// ---------------------------------------------------------------------------------------------

/**
 * The widening this file predicted at P1 entry ("a subset of the eventual P2 set (which adds
 * dependency ... shifts)"). A dependency edit is schedule-affecting, so by invariant 2 it has to
 * reach the writer as an intent rather than as an `INSERT` in a route handler — otherwise there
 * are two code paths that can move a task's dates and only one of them recomputes.
 *
 * FR-SCH-01 restricts a link to two tasks **in the same project**; `projectId` on the envelope is
 * what that is checked against, and the check is the writer's, not this schema's — a zod refinement
 * cannot see the tasks' projects.
 */
export const createDependencyIntentSchema = z
  .object({
    kind: z.literal('createDependency'),
    projectId: projectIdSchema,
    predecessorId: taskIdSchema,
    successorId: taskIdSchema,
    type: dependencyTypeSchema,
    /** FR-SCH-02: signed working hours; negative is lead. */
    lagHours: lagHoursSchema,
  })
  .strict()
  .refine((intent) => intent.predecessorId !== intent.successorId, {
    path: ['successorId'],
    message: 'FR-SCH-03: a task cannot depend on itself (self-cycle)',
  });
export type CreateDependencyIntent = z.infer<typeof createDependencyIntentSchema>;

/**
 * Retype or re-lag an existing link. The endpoints are not editable: changing which tasks a link
 * joins is a delete plus a create, because it is a different edge with a different blast radius
 * and a different cycle check.
 */
export const updateDependencyIntentSchema = z
  .object({
    kind: z.literal('updateDependency'),
    dependencyId: dependencyIdSchema,
    type: dependencyTypeSchema.optional(),
    lagHours: lagHoursSchema.optional(),
  })
  .strict()
  .refine((intent) => intent.type !== undefined || intent.lagHours !== undefined, {
    message: 'no fields to update',
  });
export type UpdateDependencyIntent = z.infer<typeof updateDependencyIntentSchema>;

/** FR-SCH-04: removing a link is as schedule-affecting as adding one. */
export const deleteDependencyIntentSchema = z
  .object({
    kind: z.literal('deleteDependency'),
    dependencyId: dependencyIdSchema,
  })
  .strict();
export type DeleteDependencyIntent = z.infer<typeof deleteDependencyIntentSchema>;

export const dependencyIntentSchema = z.union([
  createDependencyIntentSchema,
  updateDependencyIntentSchema,
  deleteDependencyIntentSchema,
]);
export type DependencyIntent = z.infer<typeof dependencyIntentSchema>;

/**
 * Every intent the P2 writer accepts.
 *
 * ## The envelope is bound to this as of contract 0.4.0 (P2 work item W2-2)
 *
 * Widening `mutationIntentEnvelopeSchema.intent` from `taskIntentSchema` to this union was a
 * **breaking** contract change on purpose: it stops `applyScheduleIntent`'s exhaustive `switch`
 * compiling until the three dependency kinds have a writer, which is the loud failure we want when
 * a new intent has none. That is why the rebind did not land in the contract commit that introduced
 * the dependency intents (0.3.0, which would have left `apps/api` red for the whole of P2's first
 * wave) but in the *same commit as the handler that satisfies it* — `apps/api/src/routes/dependencies.ts`
 * plus the dependency arm of `apps/api/src/scheduler/rollup.ts`. A contract that advertises a
 * capability the writer does not have is worse than one that lands a wave late.
 *
 * The same rule applies to the next widening (constraint-driven shifts, resource intents): add the
 * kind here, and rebind only when something can execute it.
 */
export const scheduleIntentSchema = z.union([taskIntentSchema, dependencyIntentSchema]);
export type ScheduleIntent = z.infer<typeof scheduleIntentSchema>;

/**
 * What travels from `apps/api` to the scheduler. `issuedAt` is the API's clock, not a client
 * timestamp — never trust a caller's notion of "when," per the same reasoning that keeps `Date`
 * off the wire (`primitives.ts`).
 *
 * `projectId` is the envelope's, not the intent's: `updateDependency` / `deleteDependency` (and
 * every task intent bar `createTask`) address a row by id alone, and the writer scopes that id to
 * this project before touching it. An id that resolves in another project is absent, not
 * forbidden — FR-AUTH-04.
 */
export const mutationIntentEnvelopeSchema = z.object({
  intent: scheduleIntentSchema,
  projectId: projectIdSchema,
  actorUserId: userIdSchema,
  issuedAt: isoDateTimeSchema,
});
export type MutationIntentEnvelope = z.infer<typeof mutationIntentEnvelopeSchema>;
