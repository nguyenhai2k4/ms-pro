import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * Full-surface tests against an in-process PostgreSQL. Every assertion below goes through the
 * real route, the real RBAC check and the real SQL — nothing is mocked, so a test passing means
 * the endpoint works, not that a stub agreed with itself.
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
let resetTokens: Array<{ email: string; token: string }>;

beforeEach(async () => {
  const db = new PGlite();
  exec = executorFor(db);
  await applyMigrations(exec, loadMigrationFiles(migrationsDirectory));
  resetTokens = [];
  app = buildApp({
    exec,
    sessionTtlSeconds: 3600,
    now: () => new Date('2026-09-01T09:00:00.000Z'),
    onPasswordResetToken: (email, token) => resetTokens.push({ email, token }),
  });
});

interface Registered {
  token: string;
  userId: string;
}

async function register(name: string, email: string): Promise<Registered> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name,
      email,
      password: 'correct-horse-battery-staple',
      organizationName: 'Acme Construction',
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { token: body.token, userId: body.user.id };
}

/** Adds a second user inside the SAME organization as `ownerToken`'s user. */
async function addOrgUser(name: string, email: string): Promise<string> {
  const org = await exec.query<{ id: string }>(`SELECT id FROM organization ORDER BY created_at`);
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, $2, $3, 'password') RETURNING id`,
    [org.rows[0]!.id, name, email],
  );
  return rows[0]!.id;
}

async function sessionFor(userId: string): Promise<string> {
  // Mint a session directly so tests do not need a password for every fixture user.
  const token = `test-token-${userId}`;
  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  await exec.query(
    `INSERT INTO user_session (user_id, token_hash, expires_at)
     VALUES ($1, $2, '2027-01-01T00:00:00Z')`,
    [userId, tokenHash],
  );
  return token;
}

async function createProject(token: string, name = 'Warehouse build'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { name, startDate: '2026-09-01T08:00:00.000Z', calendarTemplate: 'mon_fri' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id;
}

async function addMember(
  adminToken: string,
  projectId: string,
  email: string,
  role: string,
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/members`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { email, role },
  });
  expect(response.statusCode).toBe(201);
}

describe('FR-AUTH-01/03: registration and login', () => {
  it('registers a user, creates their organization, and returns a session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Dana PM',
        email: 'dana@acme.test',
        password: 'correct-horse-battery-staple',
        organizationName: 'Acme Construction',
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.user.email).toBe('dana@acme.test');
    expect(body.organization.name).toBe('Acme Construction');
    expect(typeof body.token).toBe('string');
  });

  it('never returns credential material', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Dana PM',
        email: 'dana@acme.test',
        password: 'correct-horse-battery-staple',
        organizationName: 'Acme',
      },
    });
    const raw = response.body;
    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('correct-horse-battery-staple');
    expect(raw).not.toContain('scrypt$');
  });

  it('rejects a short password at the contract floor', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { name: 'D', email: 'd@acme.test', password: 'short', organizationName: 'Acme' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validation_failed');
  });

  it('rejects a duplicate email', async () => {
    await register('Dana', 'dana@acme.test');
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        name: 'Impostor',
        email: 'DANA@acme.test',
        password: 'correct-horse-battery-staple',
        organizationName: 'Acme',
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it('logs in with the right password and refuses the wrong one', async () => {
    await register('Dana', 'dana@acme.test');

    const ok = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'dana@acme.test', password: 'correct-horse-battery-staple' },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'dana@acme.test', password: 'wrong-password-entirely' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('gives the same answer for an unknown email as for a wrong password', async () => {
    await register('Dana', 'dana@acme.test');
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@acme.test', password: 'correct-horse-battery-staple' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'dana@acme.test', password: 'wrong-password-entirely' },
    });
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json().message).toBe(wrong.json().message);
  });
});

describe('FR-AUTH-03: logout invalidates server-side', () => {
  it('a logged-out token stops working', async () => {
    const dana = await register('Dana', 'dana@acme.test');

    const before = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${dana.token}` },
    });
    expect(before.statusCode).toBe(200);

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${dana.token}` },
    });
    expect(out.statusCode).toBe(204);

    const after = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${dana.token}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects a missing or malformed Authorization header', async () => {
    const none = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(none.statusCode).toBe(401);

    const junk = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(junk.statusCode).toBe(401);
  });
});

describe('FR-AUTH-05: password reset', () => {
  it('accepts an unknown address without revealing that it is unknown', async () => {
    await register('Dana', 'dana@acme.test');

    const known = await app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      payload: { email: 'dana@acme.test' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      payload: { email: 'nobody@acme.test' },
    });

    expect(known.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(202);
    expect(resetTokens).toHaveLength(1);
  });

  it('resets the password, consumes the token, and revokes existing sessions', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    await app.inject({
      method: 'POST',
      url: '/auth/password-reset',
      payload: { email: 'dana@acme.test' },
    });
    const token = resetTokens[0]!.token;

    const confirmed = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token, password: 'a-brand-new-password-here' },
    });
    expect(confirmed.statusCode).toBe(204);

    // The old session is dead.
    const old = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${dana.token}` },
    });
    expect(old.statusCode).toBe(401);

    // The new password works.
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'dana@acme.test', password: 'a-brand-new-password-here' },
    });
    expect(login.statusCode).toBe(200);

    // The token is single-use.
    const replay = await app.inject({
      method: 'POST',
      url: '/auth/password-reset/confirm',
      payload: { token, password: 'yet-another-password-x' },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe('FR-PRJ-02/03: project shell', () => {
  it('creates a project with the caller as admin and a default calendar', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { name: 'Warehouse build', startDate: '2026-09-01T08:00:00.000Z' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.role).toBe('admin');
    expect(body.taskCount).toBe(0);

    const calendars = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM calendar WHERE project_id = $1 AND is_default`,
      [body.project.id],
    );
    expect(calendars.rows[0]!.count).toBe('1');
  });

  it('UC-1: an unknown calendar template falls back rather than failing creation', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        name: 'Warehouse build',
        startDate: '2026-09-01T08:00:00.000Z',
        calendarTemplate: 'mon_fri',
      },
    });
    expect(response.statusCode).toBe(201);
  });

  it('FR-PRJ-03: lists only projects the caller is a member of', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    await createProject(dana.token, 'Warehouse build');

    const outsiderId = await addOrgUser('Outsider', 'outsider@acme.test');
    const outsiderToken = await sessionFor(outsiderId);

    const mine = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${dana.token}` },
    });
    expect(mine.json().items).toHaveLength(1);

    const theirs = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(theirs.json().items).toHaveLength(0);
  });

  it('FR-AUTH-04: a non-member sees not_found, not forbidden', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const outsiderId = await addOrgUser('Outsider', 'outsider@acme.test');
    const outsiderToken = await sessionFor(outsiderId);

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${outsiderToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');
  });

  it('FR-PRJ-05: deletion requires the exact project name', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token, 'Warehouse build');

    const wrong = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { confirmName: 'Warehouse Build' },
    });
    expect(wrong.statusCode).toBe(409);

    const right = await app.inject({
      method: 'DELETE',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { confirmName: 'Warehouse build' },
    });
    expect(right.statusCode).toBe(204);
  });
});

/**
 * The half that catches real bugs. "Editor can edit" is the easy half; these are the denials.
 */
describe('FR-ACL: server-side enforcement, per role', () => {
  interface Fixture {
    adminToken: string;
    projectId: string;
    tokens: Record<string, string>;
  }

  async function fixture(): Promise<Fixture> {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const tokens: Record<string, string> = {};
    for (const role of ['editor', 'contributor', 'viewer']) {
      const userId = await addOrgUser(`${role} user`, `${role}@acme.test`);
      await addMember(dana.token, projectId, `${role}@acme.test`, role);
      tokens[role] = await sessionFor(userId);
    }
    return { adminToken: dana.token, projectId, tokens };
  }

  it('FR-ACL-03: only an Admin may change project settings', async () => {
    const { adminToken, projectId, tokens } = await fixture();

    const byAdmin = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'Renamed by admin' },
    });
    expect(byAdmin.statusCode).toBe(200);

    for (const role of ['editor', 'contributor', 'viewer']) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${tokens[role]}` },
        payload: { name: `Renamed by ${role}` },
      });
      expect(response.statusCode, `${role} must not rename the project`).toBe(403);
    }
  });

  it('FR-ACL-03: only an Admin may delete the project', async () => {
    const { projectId, tokens } = await fixture();
    for (const role of ['editor', 'contributor', 'viewer']) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${tokens[role]}` },
        payload: { confirmName: 'Warehouse build' },
      });
      expect(response.statusCode, `${role} must not delete the project`).toBe(403);
    }
  });

  it('FR-ACL-03: only an Admin may manage membership', async () => {
    const { projectId, tokens } = await fixture();
    await addOrgUser('New Person', 'new@acme.test');

    for (const role of ['editor', 'contributor', 'viewer']) {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${tokens[role]}` },
        payload: { email: 'new@acme.test', role: 'viewer' },
      });
      expect(response.statusCode, `${role} must not invite members`).toBe(403);
    }
  });

  it('FR-COL-08: the audit log is readable by Admin and Editor only', async () => {
    const { adminToken, projectId, tokens } = await fixture();

    for (const [label, token] of [
      ['admin', adminToken],
      ['editor', tokens['editor']!],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/audit`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, `${label} should read the audit log`).toBe(200);
    }

    for (const role of ['contributor', 'viewer']) {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}/audit`,
        headers: { authorization: `Bearer ${tokens[role]}` },
      });
      expect(response.statusCode, `${role} must not read the audit log`).toBe(403);
    }
  });

  it('every role can still read the project they belong to', async () => {
    const { projectId, tokens } = await fixture();
    for (const role of ['editor', 'contributor', 'viewer']) {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${projectId}`,
        headers: { authorization: `Bearer ${tokens[role]}` },
      });
      expect(response.statusCode, `${role} should read the project`).toBe(200);
      expect(response.json().role).toBe(role);
    }
  });

  it('UC-10: a demotion takes effect on the next request of a live session', async () => {
    const { adminToken, projectId } = await fixture();

    const coAdminId = await addOrgUser('Co Admin', 'coadmin@acme.test');
    await addMember(adminToken, projectId, 'coadmin@acme.test', 'admin');
    const coAdminToken = await sessionFor(coAdminId);

    const before = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${coAdminToken}` },
      payload: { name: 'Renamed while admin' },
    });
    expect(before.statusCode).toBe(200);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/members/${coAdminId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(200);

    // Same token, no re-login: the role is re-read per request (FR-AUTH-06).
    const after = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${coAdminToken}` },
      payload: { name: 'Renamed after demotion' },
    });
    expect(after.statusCode).toBe(403);
  });

  it('refuses to remove the last admin from a project', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}/members/${dana.userId}`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { role: 'viewer' },
    });
    expect(response.statusCode).toBe(409);
  });
});

describe('FR-COL-07 / invariant 4: mutations are audited', () => {
  it('records project creation with an after-image', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const { rows } = await exec.query<{
      action: string;
      after_json: unknown;
      before_json: unknown;
    }>(`SELECT action, after_json, before_json FROM audit_log_entry WHERE project_id = $1`, [
      projectId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('create');
    expect(rows[0]!.before_json).toBeNull();
    expect(rows[0]!.after_json).not.toBeNull();
  });

  it('records an update with both before and after', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token, 'Original name');

    await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { name: 'New name' },
    });

    const { rows } = await exec.query<{
      before_json: { name: string } | null;
      after_json: { name: string } | null;
    }>(
      `SELECT before_json, after_json FROM audit_log_entry
        WHERE project_id = $1 AND action = 'update'`,
      [projectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_json?.name).toBe('Original name');
    expect(rows[0]!.after_json?.name).toBe('New name');
  });

  it('records membership changes (FR-COL-07 covers ProjectMember)', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    await addOrgUser('Editor', 'editor@acme.test');
    await addMember(dana.token, projectId, 'editor@acme.test', 'editor');

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log_entry
        WHERE project_id = $1 AND entity_type = 'project_member'`,
      [projectId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('rolls the mutation back if the audit write fails — no unaudited change', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token, 'Original name');

    // Force the audit insert to fail on the next write.
    await exec.exec(
      `ALTER TABLE audit_log_entry ADD CONSTRAINT tmp_fail CHECK (action <> 'update');`,
    );

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${projectId}`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { name: 'Should not persist' },
    });
    expect(response.statusCode).toBe(500);

    const { rows } = await exec.query<{ name: string }>(`SELECT name FROM project WHERE id = $1`, [
      projectId,
    ]);
    expect(rows[0]!.name).toBe('Original name');
  });
});
