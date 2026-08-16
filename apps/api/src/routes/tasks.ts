import {
  can,
  canWriteTaskField,
  createTaskRequestSchema,
  deleteTaskRequestSchema,
  mutationIntentEnvelopeSchema,
  reparentTaskRequestSchema,
  updateTaskRequestSchema,
} from '@projectapp/shared-types';
import type { ProjectRole } from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { auditedMutation, auditRecordsFor } from '../audit/audit-writer.js';
import { requirePermission, resolveSession } from '../auth/context.js';
import { forbidden, validationFailed } from '../errors.js';
import { applyScheduleIntent, TASK_SELECT, toTask } from '../scheduler/rollup.js';
import type { TaskRow } from '../scheduler/rollup.js';
import type { AppDeps } from '../app.js';

/**
 * Task & WBS endpoints (FR-TSK-01..09).
 *
 * Two structural rules hold across every handler here:
 *
 *  1. **No schedule arithmetic.** A handler validates the request, checks RBAC, builds a
 *     `TaskIntent` and hands the envelope to `applyScheduleIntent`. Nothing in this file computes or
 *     writes `start`, `finish` or any rollup-derived column — invariant 2. Building the envelope
 *     through `mutationIntentEnvelopeSchema` rather than by hand means the contract in
 *     `packages/shared-types/src/intents.ts` is enforced at the boundary, not assumed.
 *  2. **One audit choke point.** Every mutation runs inside `auditedMutation`, and the audit rows
 *     are derived mechanically from what the scheduler reports it changed. That is what makes
 *     invariant 4 hold for *rollup side effects*: when a leaf edit moves a grandparent's dates,
 *     the grandparent's own before/after is in the list and gets its own audit row. A handler that
 *     audited only the task named in the URL would leave the schedule-affecting half unrecorded.
 */

export function registerTaskRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { exec, now } = deps;

  /** FR-TSK-01, FR-TSK-02, FR-TSK-04. */
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'task:create');

      const parsed = createTaskRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      const envelope = buildEnvelope(
        {
          kind: 'createTask',
          projectId,
          parentId: body.parentId,
          name: body.name,
          durationHours: body.durationHours,
          start: body.start,
          isMilestone: body.isMilestone,
          scheduleMode: body.scheduleMode,
          constraintType: body.constraintType,
          constraintDate: body.constraintDate,
          calendarId: body.calendarId,
          priority: body.priority,
        },
        projectId,
        user.userId,
        now(),
      );

      const outcome = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await applyScheduleIntent(exec, envelope);
          return { result, audit: auditRecordsFor('task', result.changes) };
        },
      );

      return reply.status(201).send({ task: outcome.task });
    },
  );

  /**
   * FR-TSK-02 / FR-VIEW-03: the whole project tree, flat with `parentId`. The client builds the
   * hierarchy; shipping it pre-nested would force a second, differently shaped payload the moment
   * the grid needs a flat list.
   */
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'project:read');

      // Ordered by the WBS code read as a sequence of integers, so `2` sorts before `10` and a
      // child follows its parent. Ordering on the text column would interleave them.
      const { rows } = await exec.query<TaskRow>(
        `SELECT ${TASK_SELECT} FROM task
          WHERE project_id = $1
          ORDER BY string_to_array(wbs_code, '.')::int[]`,
        [projectId],
      );

      return reply.status(200).send({ tasks: rows.map(toTask) });
    },
  );

  /** FR-TSK-01, FR-TSK-05..07, FR-TRK-04. */
  app.patch<{ Params: { projectId: string; taskId: string } }>(
    '/projects/:projectId/tasks/:taskId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, taskId } = request.params;
      // Admin, Editor and Contributor all hold this; a Viewer does not, so FR-ACL-05's read-only
      // guarantee is enforced before the body is even looked at.
      const role = await requirePermission(exec, user, projectId, 'task:update:assigned');

      const parsed = updateTaskRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());
      const body = parsed.data;

      assertFieldsWritable(role, Object.keys(body));
      assertAssignedRowLevel(role);

      const envelope = buildEnvelope(
        { kind: 'updateTask', taskId, ...body },
        projectId,
        user.userId,
        now(),
      );

      const outcome = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await applyScheduleIntent(exec, envelope);
          return { result, audit: auditRecordsFor('task', result.changes) };
        },
      );

      return reply.status(200).send({ task: outcome.task });
    },
  );

  /**
   * FR-TSK-02. A move is a structural edit, so it needs `task:update:any` — a Contributor never
   * reaches it whatever they are assigned to, which is the point of the permission being separate
   * from `task:update:assigned`.
   */
  app.post<{ Params: { projectId: string; taskId: string } }>(
    '/projects/:projectId/tasks/:taskId/reparent',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, taskId } = request.params;
      await requirePermission(exec, user, projectId, 'task:update:any');

      const parsed = reparentTaskRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());

      const envelope = buildEnvelope(
        {
          kind: 'reparentTask',
          taskId,
          newParentId: parsed.data.newParentId,
          ...(parsed.data.newIndex === undefined ? {} : { newIndex: parsed.data.newIndex }),
        },
        projectId,
        user.userId,
        now(),
      );

      const outcome = await auditedMutation(
        exec,
        { projectId, actorUserId: user.userId },
        async () => {
          const result = await applyScheduleIntent(exec, envelope);
          return { result, audit: auditRecordsFor('task', result.changes) };
        },
      );

      return reply.status(200).send({ task: outcome.task });
    },
  );

  /** FR-TSK-08, FR-TSK-09. */
  app.delete<{ Params: { projectId: string; taskId: string } }>(
    '/projects/:projectId/tasks/:taskId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, taskId } = request.params;
      await requirePermission(exec, user, projectId, 'task:delete');

      // A DELETE with no body is the ordinary case (a childless task), so an absent body is an
      // empty object rather than a validation failure.
      const parsed = deleteTaskRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) throw validationFailed(parsed.error.flatten());

      const envelope = buildEnvelope(
        {
          kind: 'deleteTask',
          taskId,
          ...(parsed.data.childPolicy === undefined
            ? {}
            : { childPolicy: parsed.data.childPolicy }),
        },
        projectId,
        user.userId,
        now(),
      );

      await auditedMutation(exec, { projectId, actorUserId: user.userId }, async () => {
        const result = await applyScheduleIntent(exec, envelope);
        return { result, audit: auditRecordsFor('task', result.changes) };
      });

      return reply.status(204).send();
    },
  );
}

/**
 * FR-ACL-04. Editors and Admins may write anything in the DTO; a Contributor is confined to
 * `CONTRIBUTOR_WRITABLE_TASK_FIELDS`. The check is per field actually present in the body, so a
 * PATCH that mixes one allowed field with one structural field is refused whole rather than
 * partially applied — a Contributor who can move `start` has structural edit power under another
 * name.
 */
function assertFieldsWritable(role: ProjectRole, fields: readonly string[]): void {
  const refused = fields.filter((field) => !canWriteTaskField(role, field));
  if (refused.length > 0) {
    throw forbidden(`Role "${role}" may not write: ${refused.join(', ')}`);
  }
}

/**
 * The row-level half of `task:update:assigned` (FR-ACL-04, UC-6). The permission grants a
 * Contributor the right to update *a* task they are assigned to; whether they are assigned to
 * *this* one is a fact about the `assignment` table, not about the role.
 *
 * In P1 that table is necessarily empty — assignment CRUD is P4 (FR-RES-03), and `resource` does
 * not yet carry a link to `app_user` at all, so there is no query that could resolve "assigned to
 * the caller". A Contributor is therefore refused on every task mutation in P1 by construction:
 * `can(role, 'task:update:any')` is false and no assignment row exists to satisfy the row-level
 * condition. This is a real permission that becomes reachable when P4 lands, not a stub — which is
 * exactly why there is no placeholder query here returning a hardcoded answer.
 */
function assertAssignedRowLevel(role: ProjectRole): void {
  if (can(role, 'task:update:any')) return;
  throw forbidden(
    `Role "${role}" may only update tasks they are assigned to, and holds no assignments`,
  );
}

/**
 * Validates the intent against its own contract on the way out of the HTTP layer. The route params
 * are the source of `projectId` and `taskId` (never a client-supplied body field), and `issuedAt`
 * is the API's clock (`intents.ts`) — a caller's notion of "when" is never trusted.
 */
function buildEnvelope(
  intent: unknown,
  projectId: string,
  actorUserId: string,
  issuedAt: Date,
): ReturnType<typeof mutationIntentEnvelopeSchema.parse> {
  const parsed = mutationIntentEnvelopeSchema.safeParse({
    intent,
    projectId,
    actorUserId,
    issuedAt: issuedAt.toISOString(),
  });
  if (!parsed.success) throw validationFailed(parsed.error.flatten());
  return parsed.data;
}
