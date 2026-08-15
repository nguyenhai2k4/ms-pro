import type { SqlExecutor } from '@projectapp/db';
import type { Permission, ProjectRole } from '@projectapp/shared-types';
import { can } from '@projectapp/shared-types';
import { forbidden, notFound, unauthenticated } from '../errors.js';
import { hashToken } from './credentials.js';

/**
 * Request identity and the permission check.
 *
 * Invariant 3 / FR-ACL-04: enforcement is server-side, on every mutating endpoint. Two properties
 * of this module are what make it hold:
 *
 *  1. **The role is read per request** (FR-AUTH-06) from `project_member`, never from the token.
 *     A role baked into a credential at login cannot be revoked, which would silently break
 *     UC-10's requirement that a demotion takes effect on a live session.
 *  2. **Absence of membership is `not_found`, not `forbidden`** (FR-AUTH-04). Distinguishing them
 *     turns any endpoint into an oracle for which project ids exist.
 */

export interface AuthenticatedUser {
  readonly userId: string;
  readonly orgId: string;
}

export async function resolveSession(
  exec: SqlExecutor,
  authorizationHeader: string | undefined,
  now: Date,
): Promise<AuthenticatedUser> {
  if (authorizationHeader === undefined || !authorizationHeader.startsWith('Bearer ')) {
    throw unauthenticated();
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (token === '') throw unauthenticated();

  const { rows } = await exec.query<{ user_id: string; org_id: string }>(
    `SELECT s.user_id, u.org_id
       FROM user_session s
       JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > $2`,
    [hashToken(token), now.toISOString()],
  );

  const row = rows[0];
  if (row === undefined) throw unauthenticated('Session is invalid or has expired');
  return { userId: row.user_id, orgId: row.org_id };
}

/**
 * The caller's role on a project, or `null` if they are not a member or the project is outside
 * their organization. The org check is in the same query on purpose: a two-step "load project,
 * then check org" invites a later refactor to drop the second step.
 */
export async function loadProjectRole(
  exec: SqlExecutor,
  user: AuthenticatedUser,
  projectId: string,
): Promise<ProjectRole | null> {
  const { rows } = await exec.query<{ role: ProjectRole }>(
    `SELECT m.role
       FROM project_member m
       JOIN project p ON p.id = m.project_id
      WHERE m.project_id = $1 AND m.user_id = $2 AND p.org_id = $3`,
    [projectId, user.userId, user.orgId],
  );
  return rows[0]?.role ?? null;
}

export async function requirePermission(
  exec: SqlExecutor,
  user: AuthenticatedUser,
  projectId: string,
  permission: Permission,
): Promise<ProjectRole> {
  const role = await loadProjectRole(exec, user, projectId);
  if (role === null) throw notFound('Project not found');
  if (!can(role, permission)) {
    throw forbidden(`Role "${role}" may not ${permission}`);
  }
  return role;
}
