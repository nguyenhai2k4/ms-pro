import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import type { ProjectRole } from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * RBAC negative paths (FR-ACL-01..04, FR-AUTH-04, FR-AUTH-06, invariant 3).
 *
 * `api.test.ts` covers four denials on three endpoints. The gaps this file closes are the ones a
 * green suite was hiding:
 *
 *  - `PATCH /projects/:id/members/:userId` — the privilege-escalation endpoint — had **no** denial
 *    test at all. A regression that dropped its `member:manage` check would have shipped green.
 *  - No endpoint had an unauthenticated / expired / revoked-session test except `/auth/me`, so
 *    "every mutating endpoint resolves a session" was asserted in prose only.
 *  - No test crossed an organization boundary. Every fixture user lived in one org, so the
 *    `p.org_id = $3` predicate in `loadProjectRole` — the whole of FR-AUTH-04's tenant isolation —
 *    could be deleted without a single test turning red.
 *  - Nothing asserted that a *denied* mutation leaves no trace: no state change and no audit row.
 *
 * The denials are the valuable half. A test that passes because a button is hidden proves nothing;
 * every request below goes through the real route, the real session lookup and the real SQL.
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

/** Registers a user, which also creates their organization (FR-PRJ-01). */
async function register(email: string, organizationName: string): Promise<Registered> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      name: email.split('@')[0],
      email,
      password: 'correct-horse-battery-staple',
      organizationName,
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { token: body.token, userId: body.user.id, orgId: body.user.orgId };
}

/** Adds a user to an existing organization without going through registration. */
async function addUserToOrg(orgId: string, email: string): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, $2, $3, 'password') RETURNING id`,
    [orgId, email.split('@')[0], email],
  );
  return rows[0]!.id;
}

async function sessionFor(userId: string, expiresAt = '2027-01-01T00:00:00Z'): Promise<string> {
  const token = `test-token-${userId}-${expiresAt}`;
  await exec.query(
    `INSERT INTO user_session (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, createHash('sha256').update(token, 'utf8').digest('hex'), expiresAt],
  );
  return token;
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

interface Fixture {
  readonly orgId: string;
  readonly adminToken: string;
  readonly adminUserId: string;
  readonly projectId: string;
  readonly tokens: Readonly<Record<Exclude<ProjectRole, 'admin'>, string>>;
  readonly userIds: Readonly<Record<Exclude<ProjectRole, 'admin'>, string>>;
}

const NON_ADMIN_ROLES = ['editor', 'contributor', 'viewer'] as const;

async function fixture(): Promise<Fixture> {
  const admin = await register('dana@acme.test', 'Acme Construction');
  const projectId = await createProject(admin.token);

  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  for (const role of NON_ADMIN_ROLES) {
    const userId = await addUserToOrg(admin.orgId, `${role}@acme.test`);
    const invite = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: `${role}@acme.test`, role },
    });
    expect(invite.statusCode).toBe(201);
    userIds[role] = userId;
    tokens[role] = await sessionFor(userId);
  }

  return {
    orgId: admin.orgId,
    adminToken: admin.token,
    adminUserId: admin.userId,
    projectId,
    tokens: tokens as Fixture['tokens'],
    userIds: userIds as Fixture['userIds'],
  };
}

/**
 * The full mutating surface of P0. Every new mutating endpoint belongs in this list — that is the
 * point of driving the denial tests from a table rather than writing them one at a time.
 */
type MutatingEndpoint = {
  readonly label: string;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly url: (f: Fixture) => string;
  readonly payload: (f: Fixture) => Record<string, unknown>;
  /** Roles that must be refused with 403 (they are members, but lack the permission). */
  readonly deniedRoles: readonly Exclude<ProjectRole, 'admin'>[];
};

const MUTATING_ENDPOINTS: readonly MutatingEndpoint[] = [
  {
    label: 'PATCH /projects/:projectId (FR-PRJ-04, FR-ACL-03)',
    method: 'PATCH',
    url: (f) => `/projects/${f.projectId}`,
    payload: () => ({ name: 'Renamed without permission' }),
    deniedRoles: NON_ADMIN_ROLES,
  },
  {
    label: 'DELETE /projects/:projectId (FR-PRJ-05, FR-ACL-03)',
    method: 'DELETE',
    url: (f) => `/projects/${f.projectId}`,
    payload: () => ({ confirmName: 'Warehouse build' }),
    deniedRoles: NON_ADMIN_ROLES,
  },
  {
    label: 'POST /projects/:projectId/members (FR-PRJ-06, FR-ACL-03)',
    method: 'POST',
    url: (f) => `/projects/${f.projectId}/members`,
    payload: () => ({ email: 'newcomer@acme.test', role: 'viewer' }),
    deniedRoles: NON_ADMIN_ROLES,
  },
  {
    // Untested before this file. This is the endpoint that grants roles.
    label: 'PATCH /projects/:projectId/members/:userId (UC-10, FR-ACL-03)',
    method: 'PATCH',
    url: (f) => `/projects/${f.projectId}/members/${f.userIds.editor}`,
    payload: () => ({ role: 'admin' }),
    deniedRoles: NON_ADMIN_ROLES,
  },
  // The dependency surface (P2, FR-SCH-01..04). An Editor holds `dependency:write` — FR-ACL-03
  // gives them full scheduling control — so only Contributor and Viewer are denied here; a
  // Contributor's exclusion *is* FR-ACL-04's "no structural edits", and a Viewer's is FR-ACL-05.
  //
  // The two id-addressed routes deliberately point at a link id that does not exist. Permission is
  // checked before the id is resolved, so the answer must still be 403 and not 404: a denied role
  // that could tell "no such link" from "not allowed" would have a working existence oracle for
  // every link in a project they may not edit. `dependencies.test.ts` covers the positive paths.
  {
    label: 'POST /projects/:projectId/dependencies (FR-SCH-01, FR-ACL-04)',
    method: 'POST',
    url: (f) => `/projects/${f.projectId}/dependencies`,
    payload: () => ({
      predecessorId: '00000000-0000-4000-8000-0000000000a1',
      successorId: '00000000-0000-4000-8000-0000000000a2',
      type: 'FS',
    }),
    deniedRoles: ['contributor', 'viewer'],
  },
  {
    label: 'PATCH /projects/:projectId/dependencies/:dependencyId (FR-SCH-02, FR-ACL-04)',
    method: 'PATCH',
    url: (f) => `/projects/${f.projectId}/dependencies/00000000-0000-4000-8000-0000000000a3`,
    payload: () => ({ lagHours: 8 }),
    deniedRoles: ['contributor', 'viewer'],
  },
  {
    label: 'DELETE /projects/:projectId/dependencies/:dependencyId (FR-SCH-04, FR-ACL-04)',
    method: 'DELETE',
    url: (f) => `/projects/${f.projectId}/dependencies/00000000-0000-4000-8000-0000000000a3`,
    payload: () => ({}),
    deniedRoles: ['contributor', 'viewer'],
  },
];

describe('FR-ACL-03 / invariant 3: the full mutating surface denies every non-admin role', () => {
  for (const endpoint of MUTATING_ENDPOINTS) {
    for (const role of endpoint.deniedRoles) {
      it(`${role} is refused 403 by ${endpoint.label}`, async () => {
        const f = await fixture();
        await addUserToOrg(f.orgId, 'newcomer@acme.test');

        const response = await app.inject({
          method: endpoint.method,
          url: endpoint.url(f),
          headers: { authorization: `Bearer ${f.tokens[role]}` },
          payload: endpoint.payload(f),
        });

        expect(response.statusCode, `${role} must not reach ${endpoint.label}`).toBe(403);
        expect(response.json().code).toBe('forbidden');
      });
    }
  }
});

describe('FR-ACL-03 / UC-10: privilege escalation through the role endpoint', () => {
  it.each(NON_ADMIN_ROLES)('%s cannot promote itself to admin', async (role) => {
    const f = await fixture();

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/members/${f.userIds[role]}`,
      headers: { authorization: `Bearer ${f.tokens[role]}` },
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(403);

    // The refusal has to be real, not just a status code: the stored role is unchanged.
    const { rows } = await exec.query<{ role: ProjectRole }>(
      `SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2`,
      [f.projectId, f.userIds[role]],
    );
    expect(rows[0]!.role).toBe(role);
  });

  it('an editor cannot demote the admin to seize sole control', async () => {
    const f = await fixture();

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/members/${f.adminUserId}`,
      headers: { authorization: `Bearer ${f.tokens.editor}` },
      payload: { role: 'viewer' },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await exec.query<{ role: ProjectRole }>(
      `SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2`,
      [f.projectId, f.adminUserId],
    );
    expect(rows[0]!.role).toBe('admin');
  });
});

describe('FR-AUTH-03: every project endpoint requires a live session', () => {
  const CASES = [
    { label: 'no Authorization header', header: undefined },
    { label: 'a non-Bearer header', header: 'Basic ZGFuYTpwdw==' },
    { label: 'an unknown bearer token', header: 'Bearer not-a-real-token' },
    { label: 'an empty bearer token', header: 'Bearer ' },
  ] as const;

  it.each(CASES)('rejects $label on the whole surface', async ({ header }) => {
    const f = await fixture();
    const routes = [
      ['GET', '/projects'],
      ['POST', '/projects'],
      ['GET', `/projects/${f.projectId}`],
      ['PATCH', `/projects/${f.projectId}`],
      ['DELETE', `/projects/${f.projectId}`],
      ['GET', `/projects/${f.projectId}/members`],
      ['POST', `/projects/${f.projectId}/members`],
      ['PATCH', `/projects/${f.projectId}/members/${f.adminUserId}`],
      ['GET', `/projects/${f.projectId}/audit`],
    ] as const;

    for (const [method, url] of routes) {
      const response = await app.inject({
        method,
        url,
        ...(header === undefined ? {} : { headers: { authorization: header } }),
        payload: {},
      });
      expect(response.statusCode, `${method} ${url} must require a session`).toBe(401);
    }
  });

  it('refuses an expired session even though the row still exists', async () => {
    const admin = await register('dana@acme.test', 'Acme');
    const expiredToken = await sessionFor(admin.userId, '2026-08-01T00:00:00Z');

    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${expiredToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a revoked session on a mutating endpoint, not only on /auth/me', async () => {
    const f = await fixture();
    await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${f.adminToken}` },
    });

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { name: 'Renamed after logout' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('FR-AUTH-04: a non-member gets not_found, never forbidden', () => {
  it('answers 404 on every mutating endpoint, so no endpoint is an id oracle', async () => {
    const f = await fixture();
    const strangerId = await addUserToOrg(f.orgId, 'stranger@acme.test');
    const strangerToken = await sessionFor(strangerId);

    const linkId = '00000000-0000-4000-8000-0000000000a3';
    const routes = [
      ['GET', `/projects/${f.projectId}`, {}],
      ['PATCH', `/projects/${f.projectId}`, { name: 'x' }],
      ['DELETE', `/projects/${f.projectId}`, { confirmName: 'Warehouse build' }],
      ['GET', `/projects/${f.projectId}/members`, {}],
      ['POST', `/projects/${f.projectId}/members`, { email: 'a@acme.test', role: 'viewer' }],
      ['PATCH', `/projects/${f.projectId}/members/${f.adminUserId}`, { role: 'viewer' }],
      ['GET', `/projects/${f.projectId}/audit`, {}],
      ['GET', `/projects/${f.projectId}/dependencies`, {}],
      ['PATCH', `/projects/${f.projectId}/dependencies/${linkId}`, { lagHours: 1 }],
      ['DELETE', `/projects/${f.projectId}/dependencies/${linkId}`, {}],
    ] as const;

    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${strangerToken}` },
        payload,
      });
      expect(response.statusCode, `${method} ${url} must answer not_found`).toBe(404);
      expect(response.json().code).toBe('not_found');
    }
  });

  it('answers 404 for a project id that does not exist at all', async () => {
    const admin = await register('dana@acme.test', 'Acme');
    const response = await app.inject({
      method: 'PATCH',
      url: '/projects/00000000-0000-4000-8000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'x' },
    });
    expect(response.statusCode).toBe(404);
  });
});

/**
 * Tenant isolation. Before this block, every fixture user shared one organization, so the org
 * predicate in `loadProjectRole` was never exercised: deleting it broke nothing that was tested.
 */
describe('FR-AUTH-04: organization boundaries hold even against a membership row', () => {
  it('refuses a user from another org holding an admin project_member row', async () => {
    const acme = await register('dana@acme.test', 'Acme Construction');
    const projectId = await createProject(acme.token);

    const other = await register('mallory@other.test', 'Other Corp');
    // Cross-org membership must never be reachable through the API; force the row directly so the
    // org predicate is the only thing standing between Mallory and the project.
    await exec.query(
      `INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [projectId, other.userId],
    );

    for (const [method, url, payload] of [
      ['GET', `/projects/${projectId}`, {}],
      ['PATCH', `/projects/${projectId}`, { name: 'owned' }],
      ['DELETE', `/projects/${projectId}`, { confirmName: 'Warehouse build' }],
      ['GET', `/projects/${projectId}/audit`, {}],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${other.token}` },
        payload,
      });
      expect(response.statusCode, `${method} ${url} must not cross the org boundary`).toBe(404);
    }

    const { rows } = await exec.query<{ name: string }>(`SELECT name FROM project WHERE id = $1`, [
      projectId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Warehouse build');
  });

  it('keeps another org out of the project list even with a membership row', async () => {
    const acme = await register('dana@acme.test', 'Acme Construction');
    const projectId = await createProject(acme.token);
    const other = await register('mallory@other.test', 'Other Corp');
    await exec.query(
      `INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [projectId, other.userId],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(0);
  });

  it('refuses to invite a user who belongs to another organization', async () => {
    const acme = await register('dana@acme.test', 'Acme Construction');
    const projectId = await createProject(acme.token);
    await register('outsider@other.test', 'Other Corp');

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${acme.token}` },
      payload: { email: 'outsider@other.test', role: 'editor' },
    });
    expect(response.statusCode).toBe(404);

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project_member WHERE project_id = $1`,
      [projectId],
    );
    expect(rows[0]!.count).toBe('1');
  });
});

/**
 * A denial must be inert. A handler that checks permission *after* it has already written, or that
 * audits an attempt as though it succeeded, produces an activity feed that disagrees with reality.
 */
describe('FR-ACL / FR-COL-07: a refused mutation changes nothing and audits nothing', () => {
  it('leaves project state and the audit log untouched after a denied rename', async () => {
    const f = await fixture();
    const auditBefore = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log_entry WHERE project_id = $1`,
      [f.projectId],
    );

    for (const role of NON_ADMIN_ROLES) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/projects/${f.projectId}`,
        headers: { authorization: `Bearer ${f.tokens[role]}` },
        payload: { name: `Renamed by ${role}` },
      });
      expect(response.statusCode).toBe(403);
    }

    const project = await exec.query<{ name: string }>(`SELECT name FROM project WHERE id = $1`, [
      f.projectId,
    ]);
    expect(project.rows[0]!.name).toBe('Warehouse build');

    const auditAfter = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log_entry WHERE project_id = $1`,
      [f.projectId],
    );
    expect(auditAfter.rows[0]!.count).toBe(auditBefore.rows[0]!.count);
  });

  it('does not delete the project when a viewer sends the correct confirmation name', async () => {
    const f = await fixture();

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}`,
      headers: { authorization: `Bearer ${f.tokens.viewer}` },
      payload: { confirmName: 'Warehouse build' },
    });
    expect(response.statusCode).toBe(403);

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project WHERE id = $1`,
      [f.projectId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('checks permission before request validation, so a malformed body cannot probe access', async () => {
    const f = await fixture();

    // A viewer sending nonsense must still be told 403, not 422: a validation error would confirm
    // the caller had got as far as the handler body.
    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}`,
      headers: { authorization: `Bearer ${f.tokens.viewer}` },
      payload: { name: 12345, unknownField: true },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('FR-ACL-01/02: a role is per project, not per user', () => {
  it('gives the same user different roles on two projects and enforces each separately', async () => {
    const admin = await register('dana@acme.test', 'Acme Construction');
    const alpha = await createProject(admin.token, 'Alpha');
    const beta = await createProject(admin.token, 'Beta');

    const samId = await addUserToOrg(admin.orgId, 'sam@acme.test');
    const samToken = await sessionFor(samId);

    for (const [projectId, role] of [
      [alpha, 'admin'],
      [beta, 'viewer'],
    ] as const) {
      const invite = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { email: 'sam@acme.test', role },
      });
      expect(invite.statusCode).toBe(201);
    }

    const onAlpha = await app.inject({
      method: 'PATCH',
      url: `/projects/${alpha}`,
      headers: { authorization: `Bearer ${samToken}` },
      payload: { name: 'Alpha renamed' },
    });
    expect(onAlpha.statusCode).toBe(200);

    const onBeta = await app.inject({
      method: 'PATCH',
      url: `/projects/${beta}`,
      headers: { authorization: `Bearer ${samToken}` },
      payload: { name: 'Beta renamed' },
    });
    expect(onBeta.statusCode).toBe(403);
  });
});
