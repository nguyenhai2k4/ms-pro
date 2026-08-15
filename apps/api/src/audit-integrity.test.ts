import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * Invariant 4 / FR-COL-07: every schedule-affecting mutation writes an audit entry with
 * before/after. `api.test.ts` proves three individual endpoints audit; it does not prove that the
 * *set* of mutating endpoints is fully covered, and it does not prove a deletion stays recorded.
 *
 * Two tests in this file are marked `it.fails` because they encode requirements the P0 code does
 * **not** meet. They are written as the requirement, not as the bug, so that fixing the defect
 * turns them red and forces the `.fails` marker to be removed. Each names the defect inline.
 */

function executorFor(db: PGlite): SqlExecutor {
  return {
    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },
    async query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }> {
      const result = await db.query<T>(text, params as unknown[] | undefined);
      return { rows: result.rows };
    },
  };
}

let app: FastifyInstance;
let exec: SqlExecutor;

beforeEach(async () => {
  const db = new PGlite();
  exec = executorFor(db);
  await applyMigrations(exec, loadMigrationFiles(migrationsDirectory));
  app = buildApp({
    exec,
    sessionTtlSeconds: 3600,
    now: () => new Date('2026-09-01T09:00:00.000Z'),
  });
});

interface Registered {
  readonly token: string;
  readonly userId: string;
  readonly orgId: string;
}

async function register(email = 'dana@acme.test', organizationName = 'Acme'): Promise<Registered> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: 'Dana',
      email,
      password: 'correct-horse-battery-staple',
      organizationName,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { token: body.token, userId: body.user.id, orgId: body.user.orgId };
}

async function addUserToOrg(orgId: string, email: string): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, $2, $3, 'password') RETURNING id`,
    [orgId, email.split('@')[0], email],
  );
  return rows[0]!.id;
}

async function createProject(token: string, name = 'Warehouse build'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { name, startDate: '2026-09-01T08:00:00.000Z' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id;
}

interface AuditRow {
  entity_type: string;
  entity_id: string;
  action: string;
  actor_user_id: string;
  before_json: Record<string, unknown> | null;
  after_json: Record<string, unknown> | null;
  created_at: Date | string;
}

async function auditRows(projectId: string): Promise<AuditRow[]> {
  const { rows } = await exec.query<AuditRow>(
    `SELECT entity_type, entity_id, action, actor_user_id, before_json, after_json, created_at
       FROM audit_log_entry WHERE project_id = $1 ORDER BY created_at`,
    [projectId],
  );
  return rows;
}

describe('FR-COL-07: the mutating surface is audited end to end', () => {
  it('records create, update, member-add and member-role-change with actor and both sides', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token, 'Original name');
    const editorId = await addUserToOrg(admin.orgId, 'editor@acme.test');

    await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'Renamed' },
    });
    await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: 'editor@acme.test', role: 'editor' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/members/${editorId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { role: 'viewer' },
    });

    const rows = await auditRows(projectId);
    const signature = rows.map((row) => `${row.entity_type}:${row.action}`);
    expect(signature).toEqual([
      'project:create',
      'project:update',
      'project_member:create',
      'project_member:update',
    ]);

    // FR-COL-07 names actor, timestamp and before/after diff. All three, on every row.
    for (const row of rows) {
      expect(row.actor_user_id).toBe(admin.userId);
      expect(row.created_at).toBeTruthy();
      if (row.action === 'create') {
        expect(row.before_json).toBeNull();
        expect(row.after_json).not.toBeNull();
      } else {
        expect(row.before_json).not.toBeNull();
        expect(row.after_json).not.toBeNull();
      }
    }

    const rename = rows[1]!;
    expect(rename.before_json?.['name']).toBe('Original name');
    expect(rename.after_json?.['name']).toBe('Renamed');

    const roleChange = rows[3]!;
    expect(roleChange.before_json?.['role']).toBe('editor');
    expect(roleChange.after_json?.['role']).toBe('viewer');
  });

  it('writes exactly one audit row per successful mutation — no double entries', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token);

    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name: `Rename ${i}` },
      });
      expect(response.statusCode).toBe(200);
    }

    const rows = await auditRows(projectId);
    expect(rows.filter((row) => row.action === 'update')).toHaveLength(3);
    expect(rows.filter((row) => row.action === 'create')).toHaveLength(1);
  });

  it('never writes an audit row for a mutation that failed validation', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token);

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(await auditRows(projectId)).toHaveLength(1); // the creation only
  });

  it('never writes an audit row for a conflict that was refused', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token, 'Warehouse build');

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirmName: 'Wrong Name' },
    });
    expect(response.statusCode).toBe(409);
    expect(await auditRows(projectId)).toHaveLength(1);
  });
});

/**
 * DEFECT (P0, open): FR-PRJ-05 requires project deletion to be recorded in the audit log, and
 * FR-COL-08 makes that log readable. The delete handler writes the audit row and then issues
 * `DELETE FROM project` in the same transaction — but `audit_log_entry.project_id` carries
 * `ON DELETE CASCADE` (0001_init.sql), so the row it just wrote is removed by the cascade before
 * the transaction commits. Zero audit rows survive a deletion.
 *
 * Minimal reproduction: create a project, delete it, `SELECT count(*) FROM audit_log_entry` -> 0.
 *
 * The schema comment claims the log "must outlive the row it describes" and the handler comment
 * claims it "records the deletion and then detaches" — there is no detach step. Fixing this needs
 * a decision (nullable project_id, a separate retention table, or ON DELETE SET NULL), which is a
 * schema change and therefore an escalation, not a QA fix.
 */
describe('FR-PRJ-05 / FR-COL-07: a deletion stays recorded', () => {
  it.fails('KNOWN DEFECT: the delete audit row survives the project delete', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token, 'Warehouse build');

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirmName: 'Warehouse build' },
    });
    expect(response.statusCode).toBe(204);

    const { rows } = await exec.query<{ action: string; before_json: unknown }>(
      `SELECT action, before_json FROM audit_log_entry
        WHERE entity_type = 'project' AND entity_id = $1 AND action = 'delete'`,
      [projectId],
    );
    expect(rows, 'a deletion that leaves no audit trail is not recorded').toHaveLength(1);
    expect(rows[0]!.before_json).not.toBeNull();
  });

  it('documents the current behaviour: nothing survives the cascade', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token, 'Warehouse build');
    await app.inject({
      method: 'DELETE',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { confirmName: 'Warehouse build' },
    });

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log_entry`,
    );
    // When the defect above is fixed, this expectation changes and both tests move together.
    expect(rows[0]!.count).toBe('0');
  });
});

/**
 * DEFECT (P0, open): FRS UC-1 error flow states "invalid calendar template -> falls back to
 * default Mon-Fri". `resolveTemplate()` in calendars.ts implements exactly that, and both
 * `api.ts` and `calendars.ts` document it — but `createProjectRequestSchema` validates
 * `calendarTemplate` with `z.enum(['mon_fri','us'])`, which rejects the request with 422 before
 * `resolveTemplate` is ever reached. The fallback is unreachable code.
 *
 * The existing test named "UC-1: an unknown calendar template falls back rather than failing
 * creation" (api.test.ts) passes `calendarTemplate: 'mon_fri'` — a *known* template — so it
 * exercises none of this and would pass against either behaviour.
 *
 * Minimal reproduction: POST /projects with `calendarTemplate: 'bogus'` -> 422, expected 201.
 */
describe('FR-CAL-04 / UC-1: an unrecognised calendar template', () => {
  it.fails('KNOWN DEFECT: falls back to Mon-Fri rather than failing creation', async () => {
    const admin = await register();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        name: 'Warehouse build',
        startDate: '2026-09-01T08:00:00.000Z',
        calendarTemplate: 'no-such-template',
      },
    });
    expect(response.statusCode, 'UC-1 error flow requires a fallback, not a rejection').toBe(201);
  });

  it('accepts both templates the contract does declare', async () => {
    const admin = await register();
    for (const calendarTemplate of ['mon_fri', 'us'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/projects',
        headers: { authorization: `Bearer ${admin.token}` },
        payload: {
          name: `Project ${calendarTemplate}`,
          startDate: '2026-09-01T08:00:00.000Z',
          calendarTemplate,
        },
      });
      expect(response.statusCode).toBe(201);
    }
  });
});

/**
 * FR-AUTH-01/03: credential material must never leave the process, on any response. The existing
 * test checks the register response only; a hash leaking through /auth/me or the project list is
 * the same defect on a different route.
 */
describe('FR-AUTH-01: no route leaks credential material', () => {
  it('keeps hashes and tokens out of every project-shell response body', async () => {
    const admin = await register();
    const projectId = await createProject(admin.token);
    const { rows } = await exec.query<{ password_hash: string }>(
      `SELECT password_hash FROM user_credential LIMIT 1`,
    );
    const storedHash = rows[0]!.password_hash;

    for (const url of [
      '/auth/me',
      '/projects',
      `/projects/${projectId}`,
      `/projects/${projectId}/members`,
      `/projects/${projectId}/audit`,
    ]) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body, `${url} leaked a password hash`).not.toContain(storedHash);
      expect(response.body).not.toContain('password_hash');
      expect(response.body).not.toContain('token_hash');
      expect(response.body).not.toContain('correct-horse-battery-staple');
    }
  });

  it('stores the session token only as a hash, never in the clear', async () => {
    const admin = await register();
    const { rows } = await exec.query<{ token_hash: string }>(
      `SELECT token_hash FROM user_session`,
    );
    expect(rows[0]!.token_hash).not.toBe(admin.token);
    expect(rows[0]!.token_hash).toBe(
      createHash('sha256').update(admin.token, 'utf8').digest('hex'),
    );
  });
});
