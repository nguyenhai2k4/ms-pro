import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import type { ProjectRole } from '@projectapp/shared-types';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

/**
 * FR-CAL-01..03 calendar CRUD: creation, editing (including the project's own default calendar),
 * exceptions, RBAC (`calendar:manage` is Admin-only), cross-project isolation (FR-AUTH-04), and
 * the audit trail (FR-COL-07 / invariant 4).
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
    payload: { name, startDate: '2026-09-01T08:00:00.000Z', calendarTemplate: 'mon_fri' },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id;
}

async function defaultCalendarId(projectId: string, token: string): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: `/projects/${projectId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json().project.calendarId;
}

const NON_ADMIN_ROLES = ['editor', 'contributor', 'viewer'] as const;

interface Fixture {
  readonly orgId: string;
  readonly adminToken: string;
  readonly adminUserId: string;
  readonly projectId: string;
  readonly calendarId: string;
  readonly tokens: Readonly<Record<Exclude<ProjectRole, 'admin'>, string>>;
  readonly userIds: Readonly<Record<Exclude<ProjectRole, 'admin'>, string>>;
}

async function fixture(): Promise<Fixture> {
  const admin = await register('dana@acme.test', 'Acme Construction');
  const projectId = await createProject(admin.token);
  const calendarId = await defaultCalendarId(projectId, admin.token);

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
    calendarId,
    tokens: tokens as Fixture['tokens'],
    userIds: userIds as Fixture['userIds'],
  };
}

async function auditRowsFor(
  projectId: string,
  entityId: string,
): Promise<
  Array<{
    action: string;
    before_json: unknown;
    after_json: unknown;
    entity_type: string;
  }>
> {
  const { rows } = await exec.query<{
    action: string;
    before_json: unknown;
    after_json: unknown;
    entity_type: string;
  }>(
    `SELECT action, entity_type, before_json, after_json
       FROM audit_log_entry
      WHERE project_id = $1 AND entity_id = $2
      ORDER BY created_at`,
    [projectId, entityId],
  );
  return rows;
}

// ------------------------------------------------------------------------------------------
// Check 1: POST creates a non-default calendar; GET (list) includes it alongside the default.
// ------------------------------------------------------------------------------------------

describe('FR-CAL-03: creating an additional calendar', () => {
  it('creates a non-default calendar and lists it alongside the project default', async () => {
    const f = await fixture();

    const created = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {
        name: 'Alice PTO',
        workingDays: [1, 2, 3, 4, 5],
        workingHoursStartMinute: 540,
        workingHoursEndMinute: 1020,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.calendar.name).toBe('Alice PTO');
    expect(body.calendar.isDefault).toBe(false);
    expect(body.calendar.projectId).toBe(f.projectId);
    expect(body.exceptions).toEqual([]);

    const list = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/calendars`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    const names = list
      .json()
      .calendars.map((c: { name: string }) => c.name)
      .sort();
    expect(names).toEqual(['Alice PTO', 'Standard (Mon-Fri, 09:00-17:00)']);
    const ids = list.json().calendars.map((c: { id: string }) => c.id);
    expect(ids).toContain(body.calendar.id);
    expect(ids).toContain(f.calendarId);
  });
});

// ------------------------------------------------------------------------------------------
// Check 2: PATCH edits the project's own default calendar.
// ------------------------------------------------------------------------------------------

describe('FR-CAL-01: editing a calendar, including the project default', () => {
  it("edits the project's own default calendar's working days/hours", async () => {
    const f = await fixture();

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {
        workingDays: [1, 2, 3, 4],
        workingHoursStartMinute: 480,
        workingHoursEndMinute: 960,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.calendar.id).toBe(f.calendarId);
    expect(body.calendar.isDefault).toBe(true);
    expect(body.calendar.workingDays).toEqual([1, 2, 3, 4]);
    expect(body.calendar.workingHoursStartMinute).toBe(480);
    expect(body.calendar.workingHoursEndMinute).toBe(960);

    const fetched = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(fetched.json().calendar.workingDays).toEqual([1, 2, 3, 4]);
  });
});

// ------------------------------------------------------------------------------------------
// Check 3: workingHoursEndMinute <= workingHoursStartMinute is rejected (422).
// ------------------------------------------------------------------------------------------

describe('FR-CAL-01/03: working-hours ordering is validated', () => {
  it('rejects creating a calendar whose end minute is not after its start minute', async () => {
    const f = await fixture();

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {
        name: 'Broken',
        workingDays: [1, 2, 3, 4, 5],
        workingHoursStartMinute: 600,
        workingHoursEndMinute: 600,
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validation_failed');
  });

  it('rejects an update that would make the end minute not-after the start minute', async () => {
    const f = await fixture();

    // Default calendar is 540-1020. Lowering only the end minute below the existing start
    // must be caught even though the request itself does not mention the start minute.
    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { workingHoursEndMinute: 500 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validation_failed');
  });
});

// ------------------------------------------------------------------------------------------
// Check 4: exceptions — a holiday and a half-day, both visible in GET.
// ------------------------------------------------------------------------------------------

describe('FR-CAL-02: date-specific exceptions', () => {
  it('adds a holiday and a half-day exception, both visible on the calendar', async () => {
    const f = await fixture();

    const holiday = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { date: '2026-12-25', isWorking: false },
    });
    expect(holiday.statusCode).toBe(201);
    expect(holiday.json().exception.isWorking).toBe(false);
    expect(holiday.json().exception.date).toBe('2026-12-25');

    const halfDay = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {
        date: '2026-12-24',
        isWorking: true,
        workingHoursStartMinuteOverride: 540,
        workingHoursEndMinuteOverride: 720,
      },
    });
    expect(halfDay.statusCode).toBe(201);
    expect(halfDay.json().exception.isWorking).toBe(true);
    expect(halfDay.json().exception.workingHoursStartMinuteOverride).toBe(540);
    expect(halfDay.json().exception.workingHoursEndMinuteOverride).toBe(720);

    const fetched = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(fetched.statusCode).toBe(200);
    const dates = fetched
      .json()
      .exceptions.map((e: { date: string }) => e.date)
      .sort();
    expect(dates).toEqual(['2026-12-24', '2026-12-25']);
  });

  // Check 5: a duplicate (calendarId, date) exception is rejected 409, not a raw DB error.
  it('rejects a duplicate exception date with 409, not a raw constraint error', async () => {
    const f = await fixture();

    const first = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { date: '2026-12-25', isWorking: false },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { date: '2026-12-25', isWorking: true },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('conflict');
    // The raw Postgres error text must never reach the client.
    expect(duplicate.body).not.toMatch(/duplicate key value/i);
    expect(duplicate.body).not.toMatch(/constraint/i);
  });

  // Check 6: DELETE removes an exception.
  it('deletes an exception', async () => {
    const f = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { date: '2026-12-25', isWorking: false },
    });
    const exceptionId = created.json().exception.id;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions/${exceptionId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(deleted.statusCode).toBe(204);

    const fetched = await app.inject({
      method: 'GET',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(fetched.json().exceptions).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// Check 7: cross-project isolation — never 403, always 404 (FR-AUTH-04).
// ------------------------------------------------------------------------------------------

describe('FR-AUTH-04: a calendar or exception in a different project is not_found, never forbidden', () => {
  it('answers 404 for every route when the calendar belongs to another project', async () => {
    const f = await fixture();
    const otherProjectId = await createProject(f.adminToken, 'Other project');

    const routes: Array<[string, string, Record<string, unknown>]> = [
      ['GET', `/projects/${otherProjectId}/calendars/${f.calendarId}`, {}],
      ['PATCH', `/projects/${otherProjectId}/calendars/${f.calendarId}`, { name: 'Hijacked' }],
      [
        'POST',
        `/projects/${otherProjectId}/calendars/${f.calendarId}/exceptions`,
        { date: '2026-12-25', isWorking: false },
      ],
    ];

    for (const [method, url, payload] of routes) {
      const response = await app.inject({
        method: method as 'GET' | 'PATCH' | 'POST',
        url,
        headers: { authorization: `Bearer ${f.adminToken}` },
        payload,
      });
      expect(response.statusCode, `${method} ${url} must be not_found`).toBe(404);
      expect(response.json().code).toBe('not_found');
    }
  });

  it('answers 404 for an exception that belongs to a calendar in another project', async () => {
    const f = await fixture();
    const otherProjectId = await createProject(f.adminToken, 'Other project');
    const otherCalendarId = await defaultCalendarId(otherProjectId, f.adminToken);

    const exception = await app.inject({
      method: 'POST',
      url: `/projects/${otherProjectId}/calendars/${otherCalendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { date: '2026-12-25', isWorking: false },
    });
    expect(exception.statusCode).toBe(201);
    const exceptionId = exception.json().exception.id;

    // Addressed through f.projectId (which does not own this calendar or exception) it must
    // be indistinguishable from an id that does not exist at all.
    const response = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/calendars/${otherCalendarId}/exceptions/${exceptionId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('not_found');

    // Same exception id, correct calendar, but under the wrong project in the URL.
    const wrongProject = await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions/${exceptionId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });
    expect(wrongProject.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------
// Check 8: RBAC — admin can do everything; editor/contributor/viewer get 403 on every mutating
// endpoint; every role gets 200 on the GET endpoints.
// ------------------------------------------------------------------------------------------

type MutatingEndpoint = {
  readonly label: string;
  readonly method: 'POST' | 'PATCH' | 'DELETE';
  readonly url: (f: Fixture, exceptionId: string) => string;
  readonly payload: () => Record<string, unknown>;
};

const MUTATING_ENDPOINTS: readonly MutatingEndpoint[] = [
  {
    label: 'POST /projects/:projectId/calendars',
    method: 'POST',
    url: (f) => `/projects/${f.projectId}/calendars`,
    payload: () => ({
      name: 'Bob PTO',
      workingDays: [1, 2, 3, 4, 5],
      workingHoursStartMinute: 540,
      workingHoursEndMinute: 1020,
    }),
  },
  {
    label: 'PATCH /projects/:projectId/calendars/:calendarId',
    method: 'PATCH',
    url: (f) => `/projects/${f.projectId}/calendars/${f.calendarId}`,
    payload: () => ({ name: 'Renamed without permission' }),
  },
  {
    label: 'POST /projects/:projectId/calendars/:calendarId/exceptions',
    method: 'POST',
    url: (f) => `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
    payload: () => ({ date: '2026-11-11', isWorking: false }),
  },
  {
    label: 'DELETE /projects/:projectId/calendars/:calendarId/exceptions/:exceptionId',
    method: 'DELETE',
    url: (f, exceptionId) =>
      `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions/${exceptionId}`,
    payload: () => ({}),
  },
];

describe('FR-ACL-03: calendar:manage is Admin-only — every mutating endpoint denies every other role', () => {
  for (const endpoint of MUTATING_ENDPOINTS) {
    for (const role of NON_ADMIN_ROLES) {
      it(`${role} is refused 403 by ${endpoint.label}`, async () => {
        const f = await fixture();
        // A pre-existing exception, inserted directly, so the DELETE case has a real target
        // regardless of whether the denial under test is for POST or DELETE.
        const { rows } = await exec.query<{ id: string }>(
          `INSERT INTO calendar_exception (calendar_id, date, is_working)
           VALUES ($1, '2026-10-31', false) RETURNING id`,
          [f.calendarId],
        );
        const exceptionId = rows[0]!.id;

        const response = await app.inject({
          method: endpoint.method,
          url: endpoint.url(f, exceptionId),
          headers: { authorization: `Bearer ${f.tokens[role]}` },
          payload: endpoint.payload(),
        });

        expect(response.statusCode, `${role} must not reach ${endpoint.label}`).toBe(403);
        expect(response.json().code).toBe('forbidden');
      });
    }

    it(`admin succeeds on ${endpoint.label}`, async () => {
      const f = await fixture();
      const { rows } = await exec.query<{ id: string }>(
        `INSERT INTO calendar_exception (calendar_id, date, is_working)
         VALUES ($1, '2026-10-31', false) RETURNING id`,
        [f.calendarId],
      );
      const exceptionId = rows[0]!.id;

      const response = await app.inject({
        method: endpoint.method,
        url: endpoint.url(f, exceptionId),
        headers: { authorization: `Bearer ${f.adminToken}` },
        payload: endpoint.payload(),
      });

      expect(response.statusCode, `admin must succeed on ${endpoint.label}`).toBeLessThan(300);
    });
  }
});

describe('FR-CAL: every role can read calendars', () => {
  it('gives 200 on GET (list) and GET (one) to admin, editor, contributor and viewer', async () => {
    const f = await fixture();
    const allTokens: Record<ProjectRole, string> = {
      admin: f.adminToken,
      ...f.tokens,
    };

    for (const role of Object.keys(allTokens) as ProjectRole[]) {
      const list = await app.inject({
        method: 'GET',
        url: `/projects/${f.projectId}/calendars`,
        headers: { authorization: `Bearer ${allTokens[role]}` },
      });
      expect(list.statusCode, `${role} GET (list) must be 200`).toBe(200);

      const one = await app.inject({
        method: 'GET',
        url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
        headers: { authorization: `Bearer ${allTokens[role]}` },
      });
      expect(one.statusCode, `${role} GET (one) must be 200`).toBe(200);
    }
  });
});

// ------------------------------------------------------------------------------------------
// Check 9: every mutation writes an audit_log_entry with entityType 'calendar' and before/after.
// ------------------------------------------------------------------------------------------

describe('FR-COL-07 / invariant 4: calendar mutations are audited', () => {
  it('audits calendar creation with an after-image and no before-image', async () => {
    const f = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: {
        name: 'Alice PTO',
        workingDays: [1, 2, 3, 4, 5],
        workingHoursStartMinute: 540,
        workingHoursEndMinute: 1020,
      },
    });
    const calendarId = response.json().calendar.id;

    const rows = await auditRowsFor(f.projectId, calendarId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_type).toBe('calendar');
    expect(rows[0]!.action).toBe('create');
    expect(rows[0]!.before_json).toBeNull();
    expect((rows[0]!.after_json as { name: string }).name).toBe('Alice PTO');
  });

  it('audits a calendar update with matching before/after', async () => {
    const f = await fixture();
    await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { name: 'Renamed default' },
    });

    const rows = await auditRowsFor(f.projectId, f.calendarId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('update');
    expect((rows[0]!.before_json as { name: string }).name).not.toBe('Renamed default');
    expect((rows[0]!.after_json as { name: string }).name).toBe('Renamed default');
  });

  it('audits adding and removing an exception, keyed to the calendar entity', async () => {
    const f = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions`,
      headers: { authorization: `Bearer ${f.adminToken}` },
      payload: { date: '2026-12-25', isWorking: false },
    });
    const exceptionId = created.json().exception.id;

    await app.inject({
      method: 'DELETE',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}/exceptions/${exceptionId}`,
      headers: { authorization: `Bearer ${f.adminToken}` },
    });

    const rows = await auditRowsFor(f.projectId, f.calendarId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.entity_type).toBe('calendar');
      expect(row.action).toBe('update');
      expect(row.before_json).not.toBeNull();
      expect(row.after_json).not.toBeNull();
    }
  });

  it('does not audit a denied mutation', async () => {
    const f = await fixture();
    const before = await auditRowsFor(f.projectId, f.calendarId);

    const response = await app.inject({
      method: 'PATCH',
      url: `/projects/${f.projectId}/calendars/${f.calendarId}`,
      headers: { authorization: `Bearer ${f.tokens.viewer}` },
      payload: { name: 'Should not happen' },
    });
    expect(response.statusCode).toBe(403);

    const after = await auditRowsFor(f.projectId, f.calendarId);
    expect(after).toHaveLength(before.length);
  });
});
