import { describe, expect, it } from 'vitest';
import type { ProjectRole } from './enums.js';
import { projectRoleSchema } from './enums.js';
import {
  CONTRIBUTOR_WRITABLE_TASK_FIELDS,
  MUTATING_PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  canWriteTaskField,
  permissionSchema,
} from './rbac.js';

const ALL_ROLES = projectRoleSchema.options;

describe('FR-ACL-01: the four roles exist and each has a permission set', () => {
  it('covers admin, editor, contributor, viewer', () => {
    expect([...ALL_ROLES].sort()).toEqual(['admin', 'contributor', 'editor', 'viewer']);
    for (const role of ALL_ROLES) {
      expect(ROLE_PERMISSIONS[role].size).toBeGreaterThan(0);
    }
  });

  it('grants only declared permissions', () => {
    const declared = new Set(permissionSchema.options);
    for (const role of ALL_ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(declared.has(permission)).toBe(true);
      }
    }
  });
});

describe('FR-ACL-03: only Admins manage membership, deletion and project settings', () => {
  const adminOnly = [
    'member:manage',
    'project:delete',
    'project:update',
    'calendar:manage',
  ] as const;

  it.each(adminOnly)('%s is admin-only', (permission) => {
    expect(can('admin', permission)).toBe(true);
    for (const role of ['editor', 'contributor', 'viewer'] as ProjectRole[]) {
      expect(can(role, permission), `${role} must not hold ${permission}`).toBe(false);
    }
  });
});

describe('FR-ACL-04: Contributors are denied structural edits', () => {
  const structural = [
    'task:create',
    'task:delete',
    'task:update:any',
    'dependency:write',
    'resource:manage',
    'assignment:manage',
  ] as const;

  it.each(structural)('contributor is denied %s', (permission) => {
    expect(can('contributor', permission)).toBe(false);
  });

  it('contributor may still update a task they are assigned to', () => {
    expect(can('contributor', 'task:update:assigned')).toBe(true);
  });

  it('editor holds every structural permission', () => {
    for (const permission of structural) {
      expect(can('editor', permission)).toBe(true);
    }
  });

  it('restricts a contributor to progress fields only', () => {
    for (const field of CONTRIBUTOR_WRITABLE_TASK_FIELDS) {
      expect(canWriteTaskField('contributor', field)).toBe(true);
    }
    // A contributor who can write these has structural edit power under another name.
    for (const field of [
      'start',
      'finish',
      'durationHours',
      'constraintType',
      'parentId',
      'priority',
    ]) {
      expect(canWriteTaskField('contributor', field), `contributor must not write ${field}`).toBe(
        false,
      );
    }
  });

  it('lets editors and admins write any task field', () => {
    for (const role of ['admin', 'editor'] as ProjectRole[]) {
      expect(canWriteTaskField(role, 'start')).toBe(true);
      expect(canWriteTaskField(role, 'durationHours')).toBe(true);
    }
  });
});

describe('FR-ACL-05: a Viewer session has no mutation channel', () => {
  it('viewer may subscribe but not mutate over the socket', () => {
    expect(can('viewer', 'realtime:subscribe')).toBe(true);
    expect(can('viewer', 'realtime:mutate')).toBe(false);
  });

  it('viewer holds no mutating permission at all', () => {
    for (const permission of MUTATING_PERMISSIONS) {
      expect(can('viewer', permission), `viewer must not hold ${permission}`).toBe(false);
    }
  });

  it('viewer can still read and export (UC-9, journey 5.4)', () => {
    expect(can('viewer', 'project:read')).toBe(true);
    expect(can('viewer', 'export:create')).toBe(true);
  });

  it('viewer commenting is not a role default — it is a per-project setting (FRS §2)', () => {
    expect(can('viewer', 'comment:create')).toBe(false);
  });
});

describe('FR-COL-08: the audit log is readable by Admin and Editor only', () => {
  it('grants audit:read to admin and editor, denies contributor and viewer', () => {
    expect(can('admin', 'audit:read')).toBe(true);
    expect(can('editor', 'audit:read')).toBe(true);
    expect(can('contributor', 'audit:read')).toBe(false);
    expect(can('viewer', 'audit:read')).toBe(false);
  });
});

describe('role capability ordering', () => {
  it('every permission a lower role holds, a higher role also holds', () => {
    // Admin ⊇ Editor ⊇ Contributor is a real property of this matrix; Viewer is deliberately
    // NOT a subset of Contributor (Viewer lacks realtime:mutate but so does nothing else), so
    // it is checked separately below.
    for (const permission of ROLE_PERMISSIONS.editor) {
      expect(can('admin', permission), `admin should hold editor's ${permission}`).toBe(true);
    }
    for (const permission of ROLE_PERMISSIONS.contributor) {
      expect(can('editor', permission), `editor should hold contributor's ${permission}`).toBe(
        true,
      );
    }
  });

  it('viewer permissions are a subset of contributor permissions', () => {
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(can('contributor', permission), `contributor should hold viewer's ${permission}`).toBe(
        true,
      );
    }
  });
});
