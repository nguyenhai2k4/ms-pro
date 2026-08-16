import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { detectCycle } from '@projectapp/cpm-engine';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import {
  dependencyCycleDetailsSchema,
  dependencyListResponseSchema,
  dependencyResponseSchema,
} from '@projectapp/shared-types';
import type { CpmDependency, CpmTask, Dependency, ProjectRole } from '@projectapp/shared-types';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * Dependency endpoints (FR-SCH-01..04) end to end against an in-process PostgreSQL: real routes,
 * real RBAC, real migrations, real SQL, and the real `packages/cpm-engine` cycle detector. Nothing
 * is mocked, so a green case means the endpoint works rather than that a stub agreed with itself.
 *
 * The three suites that carry the weight here are the ones a naive implementation passes only by
 * accident:
 *
 *  - **FR-SCH-03**: a rejected cycle must leave *no row*, not merely return 409. Every cycle case
 *    below re-lists the project's links afterwards and asserts the count is unchanged.
 *  - **FR-AUTH-04**: a real link id, or a real task id, from another project must be answered 404
 *    and never 403 — otherwise the endpoint is an oracle for what exists elsewhere.
 *  - **FR-COL-07**: a delete's audit `before` must describe the destroyed edge (both endpoints,
 *    type and lag), not just the id of a row nobody can read any more.
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

const PROJECT_START = '2026-09-01T08:00:00.000Z';
const ISSUED_AT = '2026-09-01T09:00:00.000Z';

beforeEach(async () => {
  const db = new PGlite();
  exec = executorFor(db);
  await applyMigrations(exec, loadMigrationFiles(migrationsDirectory));
  app = buildApp({
    exec,
    sessionTtlSeconds: 3600,
    now: () => new Date(ISSUED_AT),
  });
});

// ------------------------------------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------------------------------------

interface Registered {
  readonly token: string;
  readonly userId: string;
  readonly orgId: string;
}

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

async function addUserToOrg(orgId: string, email: string): Promise<string> {
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, $2, $3, 'password') RETURNING id`,
    [orgId, email.split('@')[0], email],
  );
  return rows[0]!.id;
}

async function sessionFor(userId: string): Promise<string> {
  const token = `test-token-${userId}`;
  await exec.query(
    `INSERT INTO user_session (user_id, token_hash, expires_at)
     VALUES ($1, $2, '2027-01-01T00:00:00Z')`,
    [userId, createHash('sha256').update(token, 'utf8').digest('hex')],
  );
  return token;
}

async function createProject(token: string, name = 'Warehouse build'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { name, startDate: PROJECT_START },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id;
}

async function createTask(token: string, projectId: string, name: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: { parentId: null, name, durationHours: 8, start: null },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().task.id as string;
}

const NON_ADMIN_ROLES = ['editor', 'contributor', 'viewer'] as const;

interface Fixture {
  readonly orgId: string;
  readonly adminToken: string;
  readonly adminUserId: string;
  readonly projectId: string;
  /** Four independent top-level tasks, `a` .. `d`. */
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly d: string;
  readonly tokens: Readonly<Record<Exclude<ProjectRole, 'admin'>, string>>;
}

async function fixture(): Promise<Fixture> {
  const admin = await register('dana@acme.test', 'Acme Construction');
  const projectId = await createProject(admin.token);

  const tokens: Record<string, string> = {};
  for (const role of NON_ADMIN_ROLES) {
    const userId = await addUserToOrg(admin.orgId, `${role}@acme.test`);
    const invite = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: `${role}@acme.test`, role },
    });
    expect(invite.statusCode).toBe(201);
    tokens[role] = await sessionFor(userId);
  }

  return {
    orgId: admin.orgId,
    adminToken: admin.token,
    adminUserId: admin.userId,
    projectId,
    a: await createTask(admin.token, projectId, 'Excavate'),
    b: await createTask(admin.token, projectId, 'Pour slab'),
    c: await createTask(admin.token, projectId, 'Frame'),
    d: await createTask(admin.token, projectId, 'Roof'),
    tokens: tokens as Fixture['tokens'],
  };
}

// ------------------------------------------------------------------------------------------------
// Request helpers
// ------------------------------------------------------------------------------------------------

async function postLink(
  token: string,
  projectId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/projects/${projectId}/dependencies`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

/** Creates a link and returns it, failing the test if the endpoint refused. */
async function link(
  token: string,
  projectId: string,
  predecessorId: string,
  successorId: string,
  extra: Record<string, unknown> = {},
): Promise<Dependency> {
  const response = await postLink(token, projectId, {
    predecessorId,
    successorId,
    type: 'FS',
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().dependency as Dependency;
}

async function listLinks(token: string, projectId: string): Promise<Dependency[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/projects/${projectId}/dependencies`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().dependencies as Dependency[];
}

async function dependencyAudit(projectId: string) {
  const { rows } = await exec.query<{
    entity_id: string;
    action: string;
    before_json: Record<string, unknown> | null;
    after_json: Record<string, unknown> | null;
    actor_user_id: string;
  }>(
    `SELECT entity_id, action, before_json, after_json, actor_user_id
       FROM audit_log_entry
      WHERE project_id = $1 AND entity_type = 'dependency'
      ORDER BY created_at, id`,
    [projectId],
  );
  return rows;
}

/**
 * The cycle `detectCycle` reports is rotated to start at the lowest task id and repeats that id at
 * the end (`cycle.ts`'s determinism note), so an expectation written as a literal would be a
 * coin flip on randomly generated uuids. This derives the exact expected path from the ring the
 * test built, which keeps the assertion strict without being order-dependent.
 */
function expectedCyclePath(ring: readonly string[]): string[] {
  let pivot = 0;
  for (let i = 1; i < ring.length; i += 1) {
    if (ring[i]! < ring[pivot]!) pivot = i;
  }
  const rotated = ring.map((_, i) => ring[(pivot + i) % ring.length]!);
  return [...rotated, rotated[0]!];
}

// ------------------------------------------------------------------------------------------------
// FR-SCH-01, FR-SCH-02: create and list
// ------------------------------------------------------------------------------------------------

describe('FR-SCH-01, FR-SCH-02: creating a link', () => {
  it('returns 201 with a body matching dependencyResponseSchema', async () => {
    const f = await fixture();

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.b,
      type: 'SS',
      lagHours: 4,
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(() => dependencyResponseSchema.parse(response.json())).not.toThrow();

    const dependency = response.json().dependency as Dependency;
    expect(dependency.projectId).toBe(f.projectId);
    expect(dependency.predecessorId).toBe(f.a);
    expect(dependency.successorId).toBe(f.b);
    expect(dependency.type).toBe('SS');
    expect(dependency.lagHours).toBe(4);
    // The API's clock, not the database's `now()` — an envelope replayed through the P3 queue must
    // reproduce the same timestamp rather than the time it was dequeued (`intents.ts`).
    expect(dependency.createdAt).toBe(ISSUED_AT);
  });

  it('defaults the lag to zero so a bare link is the common case (FR-SCH-02)', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);
    expect(created.lagHours).toBe(0);
  });

  it('accepts a negative lag as a lead (FR-SCH-02)', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b, { lagHours: -8 });
    expect(created.lagHours).toBe(-8);
  });

  it('accepts all four link types (FR-SCH-01)', async () => {
    const f = await fixture();
    const pairs = [
      ['FS', f.a, f.b],
      ['SS', f.a, f.c],
      ['FF', f.b, f.c],
      ['SF', f.c, f.d],
    ] as const;

    for (const [type, predecessorId, successorId] of pairs) {
      const created = await link(f.adminToken, f.projectId, predecessorId, successorId, { type });
      expect(created.type).toBe(type);
    }
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(4);
  });

  it('refuses a second link between the same ordered pair with 409 conflict', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.b,
      type: 'SS',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('conflict');
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(1);
  });

  it('rejects a malformed body with 422 rather than writing a partial row', async () => {
    const f = await fixture();

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.b,
      type: 'NOT_A_TYPE',
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validation_failed');
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(0);
  });

  /**
   * Scope boundary, asserted so its absence is documented rather than mistaken for a defect: the
   * forward/backward pass that acts on a link is work item W3-1. Until it lands a link changes the
   * graph and nothing else.
   */
  it('moves no task dates yet — propagation is W3-1, not this work item', async () => {
    const f = await fixture();
    const before = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/tasks`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });

    await link(f.adminToken, f.projectId, f.a, f.b, { lagHours: 40 });

    const after = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/tasks`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(after.json()).toEqual(before.json());
  });
});

describe('FR-SCH-01: listing links', () => {
  it('returns a body matching dependencyListResponseSchema, empty included', async () => {
    const f = await fixture();

    const empty = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/dependencies`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(() => dependencyListResponseSchema.parse(empty.json())).not.toThrow();
    expect(empty.json().dependencies).toHaveLength(0);

    await link(f.adminToken, f.projectId, f.a, f.b);
    await link(f.adminToken, f.projectId, f.b, f.c);

    const filled = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/dependencies`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(filled.statusCode).toBe(200);
    expect(() => dependencyListResponseSchema.parse(filled.json())).not.toThrow();
    expect(filled.json().dependencies).toHaveLength(2);
  });

  it('never lists another project’s links', async () => {
    const f = await fixture();
    const other = await createProject(f.adminToken, 'Bridge');
    const x = await createTask(f.adminToken, other, 'Survey');
    const y = await createTask(f.adminToken, other, 'Design');
    await link(f.adminToken, other, x, y);
    await link(f.adminToken, f.projectId, f.a, f.b);

    const mine = await listLinks(f.adminToken, f.projectId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.predecessorId).toBe(f.a);
  });
});

// ------------------------------------------------------------------------------------------------
// FR-SCH-01, FR-SCH-02: update
// ------------------------------------------------------------------------------------------------

describe('FR-SCH-01, FR-SCH-02: retyping and re-lagging', () => {
  it('updates the type and returns a body matching dependencyResponseSchema', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { type: 'FF', lagHours: -2 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(() => dependencyResponseSchema.parse(response.json())).not.toThrow();
    const updated = response.json().dependency as Dependency;
    expect(updated.type).toBe('FF');
    expect(updated.lagHours).toBe(-2);
    expect(updated.predecessorId).toBe(created.predecessorId);
    expect(updated.successorId).toBe(created.successorId);
  });

  it('leaves the field that was not sent alone', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b, { type: 'SS', lagHours: 6 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { lagHours: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json().dependency as Dependency).type).toBe('SS');
    expect((response.json().dependency as Dependency).lagHours).toBe(0);
  });

  it('refuses an empty patch and a patch that only names an endpoint (FR-SCH-01)', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);

    for (const payload of [{}, { predecessorId: f.c }, { successorId: f.c }]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/projects/${f.projectId}/dependencies/${created.id}`,
        headers: { authorization: `Bearer ${f.adminToken}` },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
    }

    // Moving an endpoint is a delete plus a create, so the stored edge is untouched.
    const [stored] = await listLinks(f.adminToken, f.projectId);
    expect(stored!.predecessorId).toBe(f.a);
    expect(stored!.successorId).toBe(f.b);
  });

  /**
   * The justification for *not* re-running `detectCycle` on a PATCH, asserted against the engine
   * itself rather than argued in a comment. `buildGraph` keys adjacency off the endpoint ids and
   * `findCycle` walks only `successorId`; if that ever stopped being true, this fails and the
   * PATCH handler needs the check back.
   */
  it('cycle-ness is a property of the edge set, not of type or lag', async () => {
    const tasks: CpmTask[] = ['a', 'b', 'c'].map((suffix) => ({
      id: `00000000-0000-4000-8000-00000000000${suffix === 'a' ? 1 : suffix === 'b' ? 2 : 3}`,
      parentId: null,
      durationHours: 8,
      isMilestone: false,
      scheduleMode: 'auto',
      constraintType: 'ASAP',
      constraintDate: null,
      calendarId: null,
      manualStart: null,
      manualFinish: null,
    })) as CpmTask[];

    const ring = (type: CpmDependency['type'], lagHours: number): CpmDependency[] =>
      [
        [tasks[0]!.id, tasks[1]!.id],
        [tasks[1]!.id, tasks[2]!.id],
        [tasks[2]!.id, tasks[0]!.id],
      ].map(([predecessorId, successorId], index) => ({
        id: `00000000-0000-4000-8000-00000000010${index}`,
        predecessorId,
        successorId,
        type,
        lagHours,
      })) as CpmDependency[];

    const chain = (type: CpmDependency['type'], lagHours: number): CpmDependency[] =>
      ring(type, lagHours).slice(0, 2);

    for (const type of ['FS', 'SS', 'FF', 'SF'] as const) {
      for (const lagHours of [-240, 0, 240]) {
        expect(detectCycle(tasks, ring(type, lagHours)), `${type}/${lagHours}`).not.toBeNull();
        expect(detectCycle(tasks, chain(type, lagHours)), `${type}/${lagHours}`).toBeNull();
      }
    }
  });
});

// ------------------------------------------------------------------------------------------------
// FR-SCH-04: delete
// ------------------------------------------------------------------------------------------------

describe('FR-SCH-04: removing a link', () => {
  it('returns 204 and drops the row', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);
    await link(f.adminToken, f.projectId, f.b, f.c);

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(response.statusCode, response.body).toBe(204);

    const remaining = await listLinks(f.adminToken, f.projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.predecessorId).toBe(f.b);
  });

  it('answers 404 for an unknown id and for a malformed one alike', async () => {
    const f = await fixture();

    for (const id of [randomUUID(), 'not-a-uuid']) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/projects/${f.projectId}/dependencies/${id}`,
        headers: { authorization: `Bearer ${f.adminToken}` },
      });
      expect(response.statusCode, id).toBe(404);
      expect(response.json().code).toBe('not_found');
    }
  });

  it('frees the pair, so the reverse-and-recreate workflow works', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);

    await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });

    const reversed = await link(f.adminToken, f.projectId, f.b, f.a);
    expect(reversed.predecessorId).toBe(f.b);
  });
});

// ------------------------------------------------------------------------------------------------
// FR-SCH-03: cycles
// ------------------------------------------------------------------------------------------------

describe('FR-SCH-03: a link that would close a loop is refused and nothing is written', () => {
  it('refuses the reverse of an existing link with 409 dependency_cycle', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.b,
      successorId: f.a,
      type: 'FS',
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('dependency_cycle');

    const details = dependencyCycleDetailsSchema.parse(response.json().details);
    expect(details.cyclePath).toEqual(expectedCyclePath([f.a, f.b]));
    expect(details.cycleDependencyIds).toHaveLength(2);

    // Nothing was written: the original link is still the only one in the project.
    const remaining = await listLinks(f.adminToken, f.projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.predecessorId).toBe(f.a);
  });

  it('refuses the closing edge of a longer chain and names the whole loop', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);
    await link(f.adminToken, f.projectId, f.b, f.c);
    await link(f.adminToken, f.projectId, f.c, f.d);

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.d,
      successorId: f.a,
      type: 'FS',
    });

    expect(response.statusCode, response.body).toBe(409);
    const details = dependencyCycleDetailsSchema.parse(response.json().details);
    expect(details.cyclePath).toEqual(expectedCyclePath([f.a, f.b, f.c, f.d]));
    expect(details.cycleDependencyIds).toHaveLength(4);

    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(3);
  });

  it('names only the loop, not everything downstream of it', async () => {
    const f = await fixture();
    // b -> c is the loop; d hangs off it and must not appear in the reported path.
    await link(f.adminToken, f.projectId, f.a, f.b);
    await link(f.adminToken, f.projectId, f.b, f.c);
    await link(f.adminToken, f.projectId, f.c, f.d);

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.c,
      successorId: f.b,
      type: 'FS',
    });

    expect(response.statusCode).toBe(409);
    const details = dependencyCycleDetailsSchema.parse(response.json().details);
    expect(details.cyclePath).toEqual(expectedCyclePath([f.b, f.c]));
    expect(details.cyclePath).not.toContain(f.d);
    expect(details.cyclePath).not.toContain(f.a);
  });

  it('refuses a self-link as the degenerate cycle, with the same code and shape', async () => {
    const f = await fixture();

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.a,
      type: 'FS',
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().code).toBe('dependency_cycle');
    const details = dependencyCycleDetailsSchema.parse(response.json().details);
    expect(details.cyclePath).toEqual([f.a, f.a]);
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(0);
  });

  it('writes no audit entry for a refused cycle — a rejection is not an event', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);
    const before = await dependencyAudit(f.projectId);

    await postLink(f.adminToken, f.projectId, {
      predecessorId: f.b,
      successorId: f.a,
      type: 'FS',
    });

    expect(await dependencyAudit(f.projectId)).toHaveLength(before.length);
  });

  it('still allows a diamond — a converging graph is not a cycle', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);
    await link(f.adminToken, f.projectId, f.a, f.c);
    await link(f.adminToken, f.projectId, f.b, f.d);
    await link(f.adminToken, f.projectId, f.c, f.d);

    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(4);
  });
});

// ------------------------------------------------------------------------------------------------
// FR-ACL-04 / FR-ACL-05 / invariant 3: RBAC
// ------------------------------------------------------------------------------------------------

describe('FR-ACL-04, FR-ACL-05: only dependency:write holders may mutate a link', () => {
  const DENIED = ['contributor', 'viewer'] as const;

  it.each(DENIED)('%s is refused 403 on create', async (role) => {
    const f = await fixture();

    const response = await postLink(f.tokens[role], f.projectId, {
      predecessorId: f.a,
      successorId: f.b,
      type: 'FS',
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().code).toBe('forbidden');
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(0);
  });

  it.each(DENIED)('%s is refused 403 on update', async (role) => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b, { type: 'FS', lagHours: 3 });

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.tokens[role]}` },
      payload: { type: 'SS', lagHours: 99 },
    });
    expect(response.statusCode, response.body).toBe(403);

    const [stored] = await listLinks(f.adminToken, f.projectId);
    expect(stored!.type).toBe('FS');
    expect(stored!.lagHours).toBe(3);
  });

  it.each(DENIED)('%s is refused 403 on delete', async (role) => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.tokens[role]}` },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(1);
  });

  it('an editor may do all three (FR-ACL-03: full scheduling control)', async () => {
    const f = await fixture();

    const created = await link(f.tokens.editor, f.projectId, f.a, f.b);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.tokens.editor}` },
      payload: { lagHours: 12 },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.tokens.editor}` },
    });
    expect(removed.statusCode).toBe(204);
  });

  it('every role can read the list, including a viewer (FR-ACL-05 is read-only, not blind)', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);

    for (const token of [f.adminToken, ...NON_ADMIN_ROLES.map((role) => f.tokens[role])]) {
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${f.projectId}/dependencies`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(() => dependencyListResponseSchema.parse(response.json())).not.toThrow();
      expect(response.json().dependencies).toHaveLength(1);
    }
  });

  it('requires a live session on every route', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);

    const routes = [
      ['GET', `/projects/${f.projectId}/dependencies`],
      ['POST', `/projects/${f.projectId}/dependencies`],
      ['PATCH', `/projects/${f.projectId}/dependencies/${created.id}`],
      ['DELETE', `/projects/${f.projectId}/dependencies/${created.id}`],
    ] as const;

    for (const [method, url] of routes) {
      const response = await app.inject({ method, url, payload: {} });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('checks permission before the body, so a malformed request cannot probe access', async () => {
    const f = await fixture();

    const response = await postLink(f.tokens.viewer, f.projectId, { nonsense: true });
    expect(response.statusCode).toBe(403);
  });
});

// ------------------------------------------------------------------------------------------------
// FR-AUTH-04: no endpoint is an id oracle
// ------------------------------------------------------------------------------------------------

describe('FR-AUTH-04: ids from another project are absent, never forbidden', () => {
  interface TwoProjects extends Fixture {
    readonly otherProjectId: string;
    readonly otherTaskA: string;
    readonly otherTaskB: string;
    readonly otherLinkId: string;
  }

  async function twoProjects(): Promise<TwoProjects> {
    const f = await fixture();
    const otherProjectId = await createProject(f.adminToken, 'Bridge');
    const otherTaskA = await createTask(f.adminToken, otherProjectId, 'Survey');
    const otherTaskB = await createTask(f.adminToken, otherProjectId, 'Design');
    const other = await link(f.adminToken, otherProjectId, otherTaskA, otherTaskB);
    return { ...f, otherProjectId, otherTaskA, otherTaskB, otherLinkId: other.id };
  }

  it('refuses a create whose predecessor belongs to another project with 404', async () => {
    const f = await twoProjects();

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.otherTaskA,
      successorId: f.b,
      type: 'FS',
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('not_found');
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(0);
  });

  it('refuses a create whose successor belongs to another project with 404', async () => {
    const f = await twoProjects();

    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.otherTaskB,
      type: 'FS',
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(0);
  });

  /**
   * The oracle test proper: a task id that *exists* and one that does not must be indistinguishable
   * through this project's routes. A handler that let the foreign id through to the foreign key and
   * rendered the resulting database error as a 500 would answer differently for the two.
   */
  it('answers a real foreign task id exactly as it answers an unused one', async () => {
    const f = await twoProjects();

    const real = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.otherTaskB,
      type: 'FS',
    });
    const invented = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: randomUUID(),
      type: 'FS',
    });

    expect(real.statusCode).toBe(invented.statusCode);
    expect(real.json().code).toBe(invented.json().code);
    expect(real.statusCode).toBe(404);
  });

  it("answers 404, not 403, for another project's valid link id on PATCH and DELETE", async () => {
    const f = await twoProjects();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/dependencies/${f.otherLinkId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { lagHours: 40 },
    });
    expect(patched.statusCode, patched.body).toBe(404);
    expect(patched.json().code).toBe('not_found');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/dependencies/${f.otherLinkId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {},
    });
    expect(removed.statusCode, removed.body).toBe(404);
    expect(removed.json().code).toBe('not_found');

    // The other project's link is untouched by either attempt.
    const survivors = await listLinks(f.adminToken, f.otherProjectId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.lagHours).toBe(0);
  });

  it('refuses a non-member on every route with 404, so membership does not leak either', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b);
    const strangerId = await addUserToOrg(f.orgId, 'stranger@acme.test');
    const strangerToken = await sessionFor(strangerId);

    const routes = [
      ['GET', `/projects/${f.projectId}/dependencies`, {}],
      [
        'POST',
        `/projects/${f.projectId}/dependencies`,
        { predecessorId: f.a, successorId: f.c, type: 'FS' },
      ],
      ['PATCH', `/projects/${f.projectId}/dependencies/${created.id}`, { lagHours: 1 }],
      ['DELETE', `/projects/${f.projectId}/dependencies/${created.id}`, {}],
    ] as const;

    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${strangerToken}` },
        payload,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json().code).toBe('not_found');
    }
  });
});

// ------------------------------------------------------------------------------------------------
// FR-COL-07 / invariant 4: the audit log
// ------------------------------------------------------------------------------------------------

describe('FR-COL-07: every dependency mutation is audited with before/after', () => {
  it('audits a create with a null before and the whole edge as after', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b, { type: 'SS', lagHours: 6 });

    const rows = await dependencyAudit(f.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('create');
    expect(rows[0]!.entity_id).toBe(created.id);
    expect(rows[0]!.actor_user_id).toBe(f.adminUserId);
    expect(rows[0]!.before_json).toBeNull();
    expect(rows[0]!.after_json).toMatchObject({
      id: created.id,
      projectId: f.projectId,
      predecessorId: f.a,
      successorId: f.b,
      type: 'SS',
      lagHours: 6,
    });
  });

  it('audits an update with both sides of the diff', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.a, f.b, { type: 'FS', lagHours: 0 });

    await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { type: 'FF', lagHours: -4 },
    });

    const rows = await dependencyAudit(f.projectId);
    expect(rows).toHaveLength(2);
    const update = rows[1]!;
    expect(update.action).toBe('update');
    expect(update.before_json).toMatchObject({ type: 'FS', lagHours: 0 });
    expect(update.after_json).toMatchObject({ type: 'FF', lagHours: -4 });
  });

  /**
   * The case the requirement exists for. An audit row that records a delete as `{ id }` and nothing
   * else cannot answer "what was removed", which is the only question anyone asks the log after a
   * link disappears from a schedule.
   */
  it('audits a delete with the destroyed edge as before, not just its id', async () => {
    const f = await fixture();
    const created = await link(f.adminToken, f.projectId, f.c, f.d, { type: 'SF', lagHours: 16 });

    await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/dependencies/${created.id}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });

    const rows = await dependencyAudit(f.projectId);
    expect(rows).toHaveLength(2);
    const remove = rows[1]!;
    expect(remove.action).toBe('delete');
    expect(remove.entity_id).toBe(created.id);
    expect(remove.after_json).toBeNull();
    expect(remove.before_json).toMatchObject({
      id: created.id,
      projectId: f.projectId,
      predecessorId: f.c,
      successorId: f.d,
      type: 'SF',
      lagHours: 16,
    });
  });

  it('audits under entity_type dependency, so the feed can tell a link from a task', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);

    const { rows } = await exec.query<{ entity_type: string; count: string }>(
      `SELECT entity_type, count(*)::text AS count FROM audit_log_entry
        WHERE project_id = $1 GROUP BY entity_type ORDER BY entity_type`,
      [f.projectId],
    );
    const byType = Object.fromEntries(rows.map((row) => [row.entity_type, row.count]));
    expect(byType['dependency']).toBe('1');
  });

  it('rolls the audit row back with the mutation when the write fails', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);
    const before = await dependencyAudit(f.projectId);

    // A duplicate pair fails inside the audited transaction; neither half may survive.
    const response = await postLink(f.adminToken, f.projectId, {
      predecessorId: f.a,
      successorId: f.b,
      type: 'FF',
    });
    expect(response.statusCode).toBe(409);

    expect(await dependencyAudit(f.projectId)).toHaveLength(before.length);
    expect(await listLinks(f.adminToken, f.projectId)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// FR-TSK-09: a deleted task takes its links with it
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-09: deleting a task removes the links that named it', () => {
  it('drops both incoming and outgoing links of the deleted task', async () => {
    const f = await fixture();
    await link(f.adminToken, f.projectId, f.a, f.b);
    await link(f.adminToken, f.projectId, f.b, f.c);
    await link(f.adminToken, f.projectId, f.c, f.d);

    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/tasks/${f.b}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {},
    });
    expect(response.statusCode, response.body).toBe(204);

    const remaining = await listLinks(f.adminToken, f.projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.predecessorId).toBe(f.c);
  });
});
