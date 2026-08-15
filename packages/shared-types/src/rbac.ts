import { z } from 'zod';
import type { ProjectRole } from './enums.js';

/**
 * The RBAC model (FR-ACL-01..05). This file is the *design*; `apps/api` applies it per endpoint
 * and `apps/scheduler` applies it per socket frame.
 *
 * Invariant 3 in `CLAUDE.md`: enforcement is server-side on every mutating endpoint. Hiding a
 * button is not access control. This table exists so that "which role may do what" is answered
 * in exactly one place — a permission matrix re-derived inside each handler grows exceptions,
 * and the exceptions are the vulnerabilities.
 *
 * Two things this matrix deliberately does **not** decide, because a role alone cannot:
 *
 *  - **Assignment scoping.** `task:update:assigned` says a Contributor may update *a* task they
 *    are assigned to (FR-ACL-04, UC-6). Whether they are assigned to *this* task is a row-level
 *    check the handler must still perform. Granting the permission is necessary, not sufficient.
 *  - **Field scoping.** A Contributor updating a task may change `pctComplete`, actual dates and
 *    notes — not `durationHours`, dates, constraints or WBS position. The permitted field set is
 *    `CONTRIBUTOR_WRITABLE_TASK_FIELDS` below, and the handler must reject anything outside it.
 *    A Contributor who can PATCH `start` has structural edit power under a different name.
 */

export const permissionSchema = z.enum([
  // Project shell (FR-PRJ-03..06, FR-ACL-03)
  'project:read',
  'project:update',
  'project:delete',
  'member:manage',
  'calendar:manage',

  // Schedule structure (FR-TSK, FR-SCH) — this is what "structural edit" means in FR-ACL-04
  'task:create',
  'task:delete',
  'task:update:any',
  'task:update:assigned',
  'dependency:write',

  // Resourcing (FR-RES)
  'resource:manage',
  'assignment:manage',

  // Tracking & collaboration (FR-TRK, FR-COL)
  'baseline:create',
  'comment:create',
  'audit:read',

  // Reporting (FR-RPT)
  'export:create',

  // Realtime channel (FR-ACL-05, FR-COL-01)
  'realtime:subscribe',
  'realtime:mutate',
]);
export type Permission = z.infer<typeof permissionSchema>;

const ADMIN: readonly Permission[] = [
  'project:read',
  'project:update',
  'project:delete',
  'member:manage',
  'calendar:manage',
  'task:create',
  'task:delete',
  'task:update:any',
  'task:update:assigned',
  'dependency:write',
  'resource:manage',
  'assignment:manage',
  'baseline:create',
  'comment:create',
  'audit:read',
  'export:create',
  'realtime:subscribe',
  'realtime:mutate',
];

/**
 * FR-ACL-03: an Editor has full scheduling control but may not manage membership, delete the
 * project, or change project-level calendars/settings.
 */
const EDITOR: readonly Permission[] = [
  'project:read',
  'task:create',
  'task:delete',
  'task:update:any',
  'task:update:assigned',
  'dependency:write',
  'resource:manage',
  'assignment:manage',
  'baseline:create',
  'comment:create',
  'audit:read',
  'export:create',
  'realtime:subscribe',
  'realtime:mutate',
];

/**
 * FR-ACL-04: no structural edits. Note the absence of `task:create`, `task:delete`,
 * `dependency:write`, `resource:manage` and `assignment:manage` — that absence is the requirement.
 */
const CONTRIBUTOR: readonly Permission[] = [
  'project:read',
  'task:update:assigned',
  'comment:create',
  'export:create',
  'realtime:subscribe',
  'realtime:mutate',
];

/**
 * FR-ACL-05: read-only subscription, and no mutation channel at all — the socket must reject a
 * mutation frame from a Viewer session outright rather than ignoring it.
 *
 * `comment:create` is absent because FRS §2 makes Viewer commenting *configurable*, so it is a
 * per-project setting layered on top of this matrix, not a role default. See
 * `viewerCommentingEnabled` in the project settings contract when that lands (P6).
 */
const VIEWER: readonly Permission[] = ['project:read', 'export:create', 'realtime:subscribe'];

export const ROLE_PERMISSIONS: Readonly<Record<ProjectRole, ReadonlySet<Permission>>> =
  Object.freeze({
    admin: new Set(ADMIN),
    editor: new Set(EDITOR),
    contributor: new Set(CONTRIBUTOR),
    viewer: new Set(VIEWER),
  });

/** The only fields a Contributor may write on a task they are assigned to (FR-ACL-04, UC-6). */
export const CONTRIBUTOR_WRITABLE_TASK_FIELDS = Object.freeze([
  'pctComplete',
  'actualStart',
  'actualFinish',
  'notes',
  'status',
] as const);

export type ContributorWritableTaskField = (typeof CONTRIBUTOR_WRITABLE_TASK_FIELDS)[number];

export function can(role: ProjectRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/**
 * True when `role` may write `field` on a task. Editors and Admins may write anything; a
 * Contributor is restricted to the progress-reporting fields.
 */
export function canWriteTaskField(role: ProjectRole, field: string): boolean {
  if (can(role, 'task:update:any')) return true;
  if (!can(role, 'task:update:assigned')) return false;
  return (CONTRIBUTOR_WRITABLE_TASK_FIELDS as readonly string[]).includes(field);
}

/** Every permission that implies the caller is mutating state — used to pick the audited path. */
export const MUTATING_PERMISSIONS: readonly Permission[] = [
  'project:update',
  'project:delete',
  'member:manage',
  'calendar:manage',
  'task:create',
  'task:delete',
  'task:update:any',
  'task:update:assigned',
  'dependency:write',
  'resource:manage',
  'assignment:manage',
  'baseline:create',
  'comment:create',
  'realtime:mutate',
];
