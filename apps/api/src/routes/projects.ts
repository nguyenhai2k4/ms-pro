import {
  createProjectRequestSchema,
  deleteProjectRequestSchema,
  inviteMemberRequestSchema,
  updateMemberRoleRequestSchema,
  updateProjectRequestSchema,
} from '@projectapp/shared-types';
import type { ProjectRole } from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { auditedMutation } from '../audit/audit-writer.js';
import { loadProjectRole, requirePermission, resolveSession } from '../auth/context.js';
import { createProjectCalendar, resolveTemplate } from '../calendars.js';
import { conflict, notFound, validationFailed } from '../errors.js';
import type { AppDeps } from '../app.js';

interface ProjectRow {
  id: string;
  org_id: string;
  name: string;
  start_date: Date | string;
  calendar_id: string;
  status_date: Date | string | null;
  created_by: string;
  created_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

const toProject = (row: ProjectRow) => ({
  id: row.id,
  orgId: row.org_id,
  name: row.name,
  startDate: iso(row.start_date),
  calendarId: row.calendar_id,
  statusDate: isoOrNull(row.status_date),
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
});

export function registerProjectRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { exec, now } = deps;

  /** FR-PRJ-02 / UC-1: the creator becomes Admin. */
  app.post('/projects', async (request, reply) => {
    const user = await resolveSession(exec, request.headers.authorization, now());
    const parsed = createProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());
    const body = parsed.data;

    await exec.exec('BEGIN');
    let project: ProjectRow;
    try {
      const calendarId = await createProjectCalendar(exec, resolveTemplate(body.calendarTemplate));
      const created = await exec.query<ProjectRow>(
        `INSERT INTO project (org_id, name, start_date, calendar_id, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, org_id, name, start_date, calendar_id, status_date, created_by, created_at`,
        [user.orgId, body.name, body.startDate, calendarId, user.userId],
      );
      project = created.rows[0]!;

      await exec.query(`UPDATE calendar SET project_id = $1 WHERE id = $2`, [
        project.id,
        calendarId,
      ]);
      await exec.query(
        `INSERT INTO project_member (project_id, user_id, role, accepted_at)
         VALUES ($1, $2, 'admin', now())`,
        [project.id, user.userId],
      );
      // FR-COL-07: creation is audited like any other mutation. Written inside the same
      // transaction as the change it describes.
      await exec.query(
        `INSERT INTO audit_log_entry
           (project_id, actor_user_id, entity_type, entity_id, action, after_json)
         VALUES ($1, $2, 'project', $3, 'create', $4)`,
        [project.id, user.userId, project.id, JSON.stringify(toProject(project))],
      );
      await exec.exec('COMMIT');
    } catch (error) {
      await exec.exec('ROLLBACK');
      throw error;
    }

    return reply.status(201).send({ project: toProject(project), role: 'admin', taskCount: 0 });
  });

  /** FR-PRJ-03: only projects the caller is a member of. */
  app.get('/projects', async (request, reply) => {
    const user = await resolveSession(exec, request.headers.authorization, now());
    const { rows } = await exec.query<ProjectRow & { role: ProjectRole; task_count: string }>(
      `SELECT p.id, p.org_id, p.name, p.start_date, p.calendar_id, p.status_date, p.created_by,
              p.created_at, m.role,
              (SELECT count(*) FROM task t WHERE t.project_id = p.id)::text AS task_count
         FROM project p
         JOIN project_member m ON m.project_id = p.id AND m.user_id = $1
        WHERE p.org_id = $2
        ORDER BY p.created_at DESC`,
      [user.userId, user.orgId],
    );
    return reply.status(200).send({
      items: rows.map((row) => ({
        project: toProject(row),
        role: row.role,
        taskCount: Number(row.task_count),
      })),
      nextCursor: null,
    });
  });

  app.get<{ Params: { projectId: string } }>('/projects/:projectId', async (request, reply) => {
    const user = await resolveSession(exec, request.headers.authorization, now());
    const { projectId } = request.params;
    const role = await requirePermission(exec, user, projectId, 'project:read');

    const { rows } = await exec.query<ProjectRow & { task_count: string }>(
      `SELECT id, org_id, name, start_date, calendar_id, status_date, created_by, created_at,
              (SELECT count(*) FROM task t WHERE t.project_id = project.id)::text AS task_count
         FROM project WHERE id = $1`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) throw notFound('Project not found');

    return reply
      .status(200)
      .send({ project: toProject(row), role, taskCount: Number(row.task_count) });
  });

  /** FR-PRJ-04 / FR-ACL-03: Admin only. */
  app.patch<{ Params: { projectId: string } }>('/projects/:projectId', async (request, reply) => {
    const user = await resolveSession(exec, request.headers.authorization, now());
    const { projectId } = request.params;
    await requirePermission(exec, user, projectId, 'project:update');

    const parsed = updateProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());
    const body = parsed.data;

    const existing = await exec.query<ProjectRow>(
      `SELECT id, org_id, name, start_date, calendar_id, status_date, created_by, created_at
         FROM project WHERE id = $1`,
      [projectId],
    );
    const before = existing.rows[0];
    if (before === undefined) throw notFound('Project not found');

    const updated = await auditedMutation(
      exec,
      { projectId, actorUserId: user.userId },
      async () => {
        const result = await exec.query<ProjectRow>(
          `UPDATE project
              SET name = COALESCE($2, name),
                  start_date = COALESCE($3, start_date),
                  status_date = CASE WHEN $4::boolean THEN $5::timestamptz ELSE status_date END
            WHERE id = $1
        RETURNING id, org_id, name, start_date, calendar_id, status_date, created_by, created_at`,
          [
            projectId,
            body.name ?? null,
            body.startDate ?? null,
            Object.prototype.hasOwnProperty.call(body, 'statusDate'),
            body.statusDate ?? null,
          ],
        );
        const after = result.rows[0]!;
        return {
          result: after,
          audit: {
            entityType: 'project' as const,
            entityId: projectId,
            action: 'update' as const,
            before: toProject(before),
            after: toProject(after),
          },
        };
      },
    );

    return reply.status(200).send({ project: toProject(updated) });
  });

  /** FR-PRJ-05: Admin only, and the caller must retype the name. */
  app.delete<{ Params: { projectId: string } }>('/projects/:projectId', async (request, reply) => {
    const user = await resolveSession(exec, request.headers.authorization, now());
    const { projectId } = request.params;
    await requirePermission(exec, user, projectId, 'project:delete');

    const parsed = deleteProjectRequestSchema.safeParse(request.body);
    if (!parsed.success) throw validationFailed(parsed.error.flatten());

    const existing = await exec.query<ProjectRow>(
      `SELECT id, org_id, name, start_date, calendar_id, status_date, created_by, created_at
         FROM project WHERE id = $1`,
      [projectId],
    );
    const before = existing.rows[0];
    if (before === undefined) throw notFound('Project not found');
    if (before.name !== parsed.data.confirmName) {
      throw conflict('The confirmation name does not match this project');
    }

    // The audit row is written before the delete cascades it away: audit_log_entry carries no FK
    // to the entity precisely so the record of a deletion survives the deletion. But the entry
    // references project_id, which the cascade would remove, so P0 records the deletion and then
    // detaches. See the note in docs/adr — retention of audit rows for deleted projects is a
    // data-retention decision, not a schema accident, and it is open (P6, FR-COL-08).
    await exec.exec('BEGIN');
    try {
      await exec.query(
        `INSERT INTO audit_log_entry
           (project_id, actor_user_id, entity_type, entity_id, action, before_json)
         VALUES ($1, $2, 'project', $3, 'delete', $4)`,
        [projectId, user.userId, projectId, JSON.stringify(toProject(before))],
      );
      await exec.query(`DELETE FROM project WHERE id = $1`, [projectId]);
      await exec.exec('COMMIT');
    } catch (error) {
      await exec.exec('ROLLBACK');
      throw error;
    }

    return reply.status(204).send();
  });

  // ------------------------------------------------------------------------------------------
  // Membership (FR-PRJ-06, FR-ACL-03, UC-10)
  // ------------------------------------------------------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/members',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'project:read');

      const { rows } = await exec.query<{
        project_id: string;
        user_id: string;
        name: string;
        email: string;
        role: ProjectRole;
        invited_at: Date | string;
        accepted_at: Date | string | null;
      }>(
        `SELECT m.project_id, m.user_id, u.name, u.email, m.role, m.invited_at, m.accepted_at
           FROM project_member m
           JOIN app_user u ON u.id = m.user_id
          WHERE m.project_id = $1
          ORDER BY m.invited_at`,
        [projectId],
      );

      return reply.status(200).send({
        items: rows.map((row) => ({
          projectId: row.project_id,
          userId: row.user_id,
          name: row.name,
          email: row.email,
          role: row.role,
          invitedAt: iso(row.invited_at),
          acceptedAt: isoOrNull(row.accepted_at),
        })),
        nextCursor: null,
      });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/members',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'member:manage');

      const parsed = inviteMemberRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());

      // FR-AUTH-04: invitees must already exist inside the caller's organization. Cross-org
      // invitation is not MVP scope (one organization per user, FR-PRJ-01).
      const invitee = await exec.query<{ id: string }>(
        `SELECT id FROM app_user WHERE lower(email) = lower($1) AND org_id = $2`,
        [parsed.data.email, user.orgId],
      );
      const inviteeId = invitee.rows[0]?.id;
      if (inviteeId === undefined) throw notFound('No user with that email in this organization');

      const existing = await loadProjectRole(
        exec,
        { userId: inviteeId, orgId: user.orgId },
        projectId,
      );
      if (existing !== null) throw conflict('That user is already a member of this project');

      await auditedMutation(exec, { projectId, actorUserId: user.userId }, async () => {
        await exec.query(
          `INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3)`,
          [projectId, inviteeId, parsed.data.role],
        );
        return {
          result: null,
          audit: {
            entityType: 'project_member' as const,
            entityId: inviteeId,
            action: 'create' as const,
            after: { projectId, userId: inviteeId, role: parsed.data.role },
          },
        };
      });

      return reply.status(201).send({ projectId, userId: inviteeId, role: parsed.data.role });
    },
  );

  /**
   * UC-10: a role change takes effect on the invitee's live session immediately. That is not
   * implemented here by pushing anything — it is true because `loadProjectRole` re-reads this row
   * on every request (FR-AUTH-06). The absence of cache-invalidation code is the design.
   */
  app.patch<{ Params: { projectId: string; userId: string } }>(
    '/projects/:projectId/members/:userId',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId, userId } = request.params;
      await requirePermission(exec, user, projectId, 'member:manage');

      const parsed = updateMemberRoleRequestSchema.safeParse(request.body);
      if (!parsed.success) throw validationFailed(parsed.error.flatten());

      const current = await exec.query<{ role: ProjectRole }>(
        `SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2`,
        [projectId, userId],
      );
      const before = current.rows[0];
      if (before === undefined) throw notFound('That user is not a member of this project');

      // A project with no admin cannot be administered again, and support cannot fix it for you.
      if (before.role === 'admin' && parsed.data.role !== 'admin') {
        const admins = await exec.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM project_member
            WHERE project_id = $1 AND role = 'admin'`,
          [projectId],
        );
        if (Number(admins.rows[0]!.count) <= 1) {
          throw conflict('A project must keep at least one admin');
        }
      }

      await auditedMutation(exec, { projectId, actorUserId: user.userId }, async () => {
        await exec.query(
          `UPDATE project_member SET role = $3 WHERE project_id = $1 AND user_id = $2`,
          [projectId, userId, parsed.data.role],
        );
        return {
          result: null,
          audit: {
            entityType: 'project_member' as const,
            entityId: userId,
            action: 'update' as const,
            before: { projectId, userId, role: before.role },
            after: { projectId, userId, role: parsed.data.role },
          },
        };
      });

      return reply.status(200).send({ projectId, userId, role: parsed.data.role });
    },
  );

  /** FR-COL-08: Admin and Editor only. */
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/audit',
    async (request, reply) => {
      const user = await resolveSession(exec, request.headers.authorization, now());
      const { projectId } = request.params;
      await requirePermission(exec, user, projectId, 'audit:read');

      const { rows } = await exec.query<{
        id: string;
        project_id: string;
        actor_user_id: string;
        entity_type: string;
        entity_id: string;
        action: string;
        before_json: unknown;
        after_json: unknown;
        created_at: Date | string;
      }>(
        `SELECT id, project_id, actor_user_id, entity_type, entity_id, action,
                before_json, after_json, created_at
           FROM audit_log_entry
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 200`,
        [projectId],
      );

      return reply.status(200).send({
        items: rows.map((row) => ({
          id: row.id,
          projectId: row.project_id,
          actorUserId: row.actor_user_id,
          entityType: row.entity_type,
          entityId: row.entity_id,
          action: row.action,
          before: row.before_json ?? null,
          after: row.after_json ?? null,
          createdAt: iso(row.created_at),
        })),
        nextCursor: null,
      });
    },
  );
}
