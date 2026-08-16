import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import { taskListResponseSchema, taskResponseSchema } from '@projectapp/shared-types';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

/**
 * Task & WBS endpoints (FR-TSK-01..09) and the P1 rollup scheduler, end to end against an
 * in-process PostgreSQL: real routes, real RBAC, real SQL, real migrations. Nothing is mocked, so
 * a green test means the endpoint works rather than that a stub agreed with itself.
 *
 * The rollup assertions are the reason this suite exists. A wrong parent date is not a visible
 * failure — it is a schedule that looks plausible and is wrong, on every ancestor of every edited
 * task, which is why the ancestor chain, the mixed schedule modes and the duration weighting each
 * get a case that would pass under a naive implementation only by accident.
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
  const token = `test-token-${userId}`;
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  await exec.query(
    `INSERT INTO user_session (user_id, token_hash, expires_at)
     VALUES ($1, $2, '2027-01-01T00:00:00Z')`,
    [userId, tokenHash],
  );
  return token;
}

async function createProject(token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Warehouse build', startDate: PROJECT_START },
  });
  expect(response.statusCode).toBe(201);
  return response.json().project.id;
}

interface TaskInput {
  readonly parentId?: string | null;
  readonly name?: string;
  readonly durationHours?: number;
  readonly start?: string | null;
  readonly isMilestone?: boolean;
  readonly scheduleMode?: 'auto' | 'manual';
}

interface TaskShape {
  id: string;
  parentId: string | null;
  wbsCode: string;
  name: string;
  durationHours: number;
  start: string;
  finish: string;
  pctComplete: number;
  isMilestone: boolean;
  scheduleMode: string;
  status: string;
  priority: number;
  calendarId: string | null;
  notes: string;
}

async function post(
  token: string,
  projectId: string,
  input: TaskInput = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      parentId: input.parentId ?? null,
      name: input.name ?? 'Task',
      durationHours: input.durationHours ?? 8,
      start: input.start ?? null,
      ...(input.isMilestone === undefined ? {} : { isMilestone: input.isMilestone }),
      ...(input.scheduleMode === undefined ? {} : { scheduleMode: input.scheduleMode }),
    },
  });
}

/** Creates a task and returns it, failing the test if the endpoint refused. */
async function createTask(
  token: string,
  projectId: string,
  input: TaskInput = {},
): Promise<TaskShape> {
  const response = await post(token, projectId, input);
  expect(response.statusCode, response.body).toBe(201);
  return response.json().task as TaskShape;
}

async function patch(
  token: string,
  projectId: string,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PATCH',
    url: `/projects/${projectId}/tasks/${taskId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function reparent(
  token: string,
  projectId: string,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/projects/${projectId}/tasks/${taskId}/reparent`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function remove(
  token: string,
  projectId: string,
  taskId: string,
  payload: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'DELETE',
    url: `/projects/${projectId}/tasks/${taskId}`,
    headers: { authorization: `Bearer ${token}` },
    payload,
  });
}

async function readTask(token: string, projectId: string, taskId: string): Promise<TaskShape> {
  const response = await app.inject({
    method: 'GET',
    url: `/projects/${projectId}/tasks`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  const found = (response.json().tasks as TaskShape[]).find((task) => task.id === taskId);
  expect(found, `task ${taskId} is missing from the project tree`).toBeDefined();
  return found!;
}

async function auditRows(projectId: string, entityId?: string) {
  const { rows } =
    entityId === undefined
      ? await exec.query<{ entity_id: string; action: string; before_json: unknown }>(
          `SELECT entity_id, action, before_json FROM audit_log_entry
            WHERE project_id = $1 AND entity_type = 'task' ORDER BY created_at`,
          [projectId],
        )
      : await exec.query<{ entity_id: string; action: string; before_json: unknown }>(
          `SELECT entity_id, action, before_json FROM audit_log_entry
            WHERE project_id = $1 AND entity_type = 'task' AND entity_id = $2
            ORDER BY created_at`,
          [projectId, entityId],
        );
  return rows;
}

// ------------------------------------------------------------------------------------------------
// FR-TSK-01 / FR-TSK-02: create and WBS numbering
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-01, FR-TSK-04: creating a task', () => {
  it('assigns a WBS code, applies defaults, audits the create and matches the DTO', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const response = await post(dana.token, projectId, { name: 'Pour slab', durationHours: 16 });
    expect(response.statusCode).toBe(201);
    expect(() => taskResponseSchema.parse(response.json())).not.toThrow();

    const task = response.json().task as TaskShape;
    expect(task.wbsCode).toBe('1');
    expect(task.parentId).toBeNull();
    expect(task.pctComplete).toBe(0);
    expect(task.status).toBe('not_started');
    expect(task.priority).toBe(500);
    expect(task.scheduleMode).toBe('auto');
    // FR-SCH-09: no explicit start, so the task begins at the project start date. The finish is
    // the wall-clock span of its duration — calendar-aware date math is FR-SCH-07 (P2).
    expect(task.start).toBe(PROJECT_START);
    expect(task.finish).toBe('2026-09-02T00:00:00.000Z');

    const audit = await auditRows(projectId, task.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('create');
    expect(audit[0]!.before_json).toBeNull();
  });

  it('numbers top-level siblings 1, 2, 3 and children as <parent>.<n>', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const first = await createTask(dana.token, projectId, { name: 'Phase 1' });
    const second = await createTask(dana.token, projectId, { name: 'Phase 2' });
    const childA = await createTask(dana.token, projectId, {
      parentId: first.id,
      name: 'Excavate',
    });
    const childB = await createTask(dana.token, projectId, { parentId: first.id, name: 'Pour' });
    const grandchild = await createTask(dana.token, projectId, {
      parentId: childB.id,
      name: 'Cure',
    });

    expect([first.wbsCode, second.wbsCode]).toEqual(['1', '2']);
    expect([childA.wbsCode, childB.wbsCode]).toEqual(['1.1', '1.2']);
    expect(grandchild.wbsCode).toBe('1.2.1');
  });

  it('keeps (project_id, wbs_code) unique across the project', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id });
    await createTask(dana.token, projectId, { parentId: parent.id });
    await createTask(dana.token, projectId);

    const { rows } = await exec.query<{ codes: string; distinct: string }>(
      `SELECT count(wbs_code)::text AS codes, count(DISTINCT wbs_code)::text AS distinct
         FROM task WHERE project_id = $1`,
      [projectId],
    );
    expect(rows[0]!.codes).toBe('4');
    expect(rows[0]!.distinct).toBe('4');
  });

  it('FR-TSK-04: surfaces the milestone invariant as 422, not as a database error', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const response = await post(dana.token, projectId, { isMilestone: true, durationHours: 8 });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validation_failed');
  });

  it('FR-TSK-06: a dated constraint needs a date, and ASAP must not carry one', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const missingDate = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        parentId: null,
        name: 'Must start on',
        durationHours: 8,
        start: null,
        constraintType: 'MSO',
      },
    });
    expect(missingDate.statusCode).toBe(422);

    // The other half of the database's task_constraint_date_required check, which
    // taskInvariantsSchema does not express — a 500 here would be a schema error reaching the user.
    const spuriousDate = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        parentId: null,
        name: 'As soon as possible',
        durationHours: 8,
        start: null,
        constraintType: 'ASAP',
        constraintDate: '2026-10-01T00:00:00.000Z',
      },
    });
    expect(spuriousDate.statusCode).toBe(422);
  });

  it('lists the project tree flat, in WBS order (2 before 10)', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase 1' });
    for (let index = 0; index < 10; index += 1) {
      await createTask(dana.token, projectId, { parentId: parent.id, name: `Step ${index}` });
    }

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(() => taskListResponseSchema.parse(response.json())).not.toThrow();

    const codes = (response.json().tasks as TaskShape[]).map((task) => task.wbsCode);
    expect(codes.slice(0, 4)).toEqual(['1', '1.1', '1.2', '1.3']);
    expect(codes[codes.length - 1]).toBe('1.10');
  });
});

// ------------------------------------------------------------------------------------------------
// FR-TSK-03 / FR-TSK-05 / FR-TRK-04: rollup
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-03: parent tasks roll up from their children', () => {
  it('updates the parent when a child is created, and audits the parent too', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase 1', durationHours: 8 });

    await createTask(dana.token, projectId, {
      parentId: parent.id,
      start: '2026-09-10T00:00:00.000Z',
      durationHours: 24,
    });

    const rolled = await readTask(dana.token, projectId, parent.id);
    expect(rolled.start).toBe('2026-09-10T00:00:00.000Z');
    expect(rolled.finish).toBe('2026-09-11T00:00:00.000Z');
    expect(rolled.durationHours).toBe(24);
    expect(rolled.pctComplete).toBe(0);

    // Invariant 4: the parent's dates moved, which is schedule-affecting, so it is audited in its
    // own right rather than being an invisible side effect of the child's create.
    const parentAudit = await auditRows(projectId, parent.id);
    expect(parentAudit.map((row) => row.action)).toEqual(['create', 'update']);
  });

  it('reaches the grandparent, not just the immediate parent', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const grandparent = await createTask(dana.token, projectId, { name: 'Programme' });
    const parent = await createTask(dana.token, projectId, {
      parentId: grandparent.id,
      name: 'Phase',
    });
    const leaf = await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'Task',
      start: '2026-09-05T00:00:00.000Z',
      durationHours: 8,
    });

    const moved = await patch(dana.token, projectId, leaf.id, {
      start: '2026-10-01T00:00:00.000Z',
      durationHours: 48,
      pctComplete: 50,
    });
    expect(moved.statusCode, moved.body).toBe(200);

    for (const ancestor of [parent, grandparent]) {
      const rolled = await readTask(dana.token, projectId, ancestor.id);
      expect(rolled.start, `${ancestor.name} start`).toBe('2026-10-01T00:00:00.000Z');
      expect(rolled.finish, `${ancestor.name} finish`).toBe('2026-10-03T00:00:00.000Z');
      expect(rolled.durationHours, `${ancestor.name} duration`).toBe(48);
      expect(rolled.pctComplete, `${ancestor.name} pctComplete`).toBe(50);
    }

    // The grandparent's own audit trail records the rollup-driven change (invariant 4).
    const grandparentAudit = await auditRows(projectId, grandparent.id);
    expect(grandparentAudit.filter((row) => row.action === 'update').length).toBeGreaterThan(0);
  });

  it('FR-TSK-05: a manually scheduled child still contributes to the rollup', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase' });

    await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'Auto child',
      scheduleMode: 'auto',
      start: '2026-09-10T00:00:00.000Z',
      durationHours: 24,
    });
    await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'Manual child',
      scheduleMode: 'manual',
      start: '2026-09-05T00:00:00.000Z',
      durationHours: 24,
    });

    const rolled = await readTask(dana.token, projectId, parent.id);
    // Without the manual child the span would start on the 10th and the bug would be invisible.
    expect(rolled.start).toBe('2026-09-05T00:00:00.000Z');
    expect(rolled.finish).toBe('2026-09-11T00:00:00.000Z');
    expect(rolled.durationHours).toBe(144);
  });

  it('FR-TRK-04: % complete is duration-weighted, not a plain average', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase' });

    const short = await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'Short',
      start: '2026-09-01T00:00:00.000Z',
      durationHours: 10,
    });
    await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'Long',
      start: '2026-09-01T00:00:00.000Z',
      durationHours: 30,
    });

    expect((await patch(dana.token, projectId, short.id, { pctComplete: 100 })).statusCode).toBe(
      200,
    );

    // Plain average would be 50; duration-weighted is (100*10 + 0*30) / 40 = 25.
    const rolled = await readTask(dana.token, projectId, parent.id);
    expect(rolled.pctComplete).toBe(25);
  });

  it('refuses a direct % complete edit on a summary task (FR-TSK-03, FR-TRK-04)', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id });

    const response = await patch(dana.token, projectId, parent.id, { pctComplete: 40 });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('validation_failed');

    // The same field on a leaf is fine — this is about summary tasks, not about the field.
    const leaf = await createTask(dana.token, projectId);
    expect((await patch(dana.token, projectId, leaf.id, { pctComplete: 40 })).statusCode).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------
// FR-TSK-02: reparenting
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-02: reparenting a task', () => {
  it('renumbers the whole moved subtree and rolls up both ancestor chains', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const phaseOne = await createTask(dana.token, projectId, { name: 'Phase 1' });
    const phaseTwo = await createTask(dana.token, projectId, { name: 'Phase 2' });
    const moved = await createTask(dana.token, projectId, {
      parentId: phaseOne.id,
      name: 'Moved',
      start: '2026-10-01T00:00:00.000Z',
      durationHours: 24,
    });
    const grandchild = await createTask(dana.token, projectId, {
      parentId: moved.id,
      name: 'Grandchild',
      start: '2026-10-01T00:00:00.000Z',
      durationHours: 48,
    });
    // Phase 2 already holds a child, so the move has to fit into an existing sibling order.
    const sitting = await createTask(dana.token, projectId, {
      parentId: phaseTwo.id,
      name: 'Sitting',
      start: '2026-09-20T00:00:00.000Z',
      durationHours: 24,
    });
    expect([moved.wbsCode, grandchild.wbsCode, sitting.wbsCode]).toEqual(['1.1', '1.1.1', '2.1']);

    const response = await reparent(dana.token, projectId, moved.id, {
      newParentId: phaseTwo.id,
      newIndex: 0,
    });
    expect(response.statusCode, response.body).toBe(200);

    expect((await readTask(dana.token, projectId, moved.id)).wbsCode).toBe('2.1');
    expect((await readTask(dana.token, projectId, grandchild.id)).wbsCode).toBe('2.1.1');
    expect((await readTask(dana.token, projectId, sitting.id)).wbsCode).toBe('2.2');
    expect((await readTask(dana.token, projectId, moved.id)).parentId).toBe(phaseTwo.id);

    // New chain: Phase 2 now spans the sitting child and the moved subtree.
    const newParent = await readTask(dana.token, projectId, phaseTwo.id);
    expect(newParent.start).toBe('2026-09-20T00:00:00.000Z');
    expect(newParent.finish).toBe('2026-10-03T00:00:00.000Z');

    // Old chain: Phase 1 is childless again and keeps the dates it last held as a leaf.
    const oldParent = await readTask(dana.token, projectId, phaseOne.id);
    expect(oldParent.parentId).toBeNull();

    // Every task the move touched is audited, including the sibling it renumbered.
    const sittingAudit = await auditRows(projectId, sitting.id);
    expect(sittingAudit.map((row) => row.action)).toContain('update');
  });

  it('appends to the end of the new parent when no index is given', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const target = await createTask(dana.token, projectId, { name: 'Target' });
    await createTask(dana.token, projectId, { parentId: target.id, name: 'First' });
    const moving = await createTask(dana.token, projectId, { name: 'Moving' });

    expect(
      (await reparent(dana.token, projectId, moving.id, { newParentId: target.id })).statusCode,
    ).toBe(200);
    expect((await readTask(dana.token, projectId, moving.id)).wbsCode).toBe('1.2');
  });

  it('moves a task back to the top level', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Parent' });
    const child = await createTask(dana.token, projectId, { parentId: parent.id, name: 'Child' });

    expect(
      (await reparent(dana.token, projectId, child.id, { newParentId: null })).statusCode,
    ).toBe(200);
    const moved = await readTask(dana.token, projectId, child.id);
    expect(moved.parentId).toBeNull();
    expect(moved.wbsCode).toBe('2');
  });

  it('rejects a move that would make a task its own ancestor', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const root = await createTask(dana.token, projectId, { name: 'Root' });
    const child = await createTask(dana.token, projectId, { parentId: root.id, name: 'Child' });
    const grandchild = await createTask(dana.token, projectId, {
      parentId: child.id,
      name: 'Grandchild',
    });

    // Two levels down — beyond what the database's parent_id <> id check can see.
    const deep = await reparent(dana.token, projectId, root.id, { newParentId: grandchild.id });
    expect(deep.statusCode).toBe(422);
    expect(deep.json().code).toBe('validation_failed');

    const self = await reparent(dana.token, projectId, root.id, { newParentId: root.id });
    expect(self.statusCode).toBe(422);

    // The rejected move left nothing behind.
    expect((await readTask(dana.token, projectId, root.id)).parentId).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// FR-TSK-08 / FR-TSK-09: deletion
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-08: deleting a task', () => {
  it('deletes a childless task and audits the removal', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const task = await createTask(dana.token, projectId);

    expect((await remove(dana.token, projectId, task.id)).statusCode).toBe(204);

    const audit = await auditRows(projectId, task.id);
    expect(audit.map((row) => row.action)).toEqual(['create', 'delete']);
    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task WHERE id = $1`,
      [task.id],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('needs an explicit policy when the task has children, and refuses one when it does not', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id });
    const childless = await createTask(dana.token, projectId);

    // The two error paths are distinguishable without a prior lookup: 422 means "you owe me a
    // decision", 409 means "the decision does not apply here".
    const missingPolicy = await remove(dana.token, projectId, parent.id, {});
    expect(missingPolicy.statusCode).toBe(422);
    expect(missingPolicy.json().code).toBe('validation_failed');

    const spuriousPolicy = await remove(dana.token, projectId, childless.id, {
      childPolicy: 'cascade',
    });
    expect(spuriousPolicy.statusCode).toBe(409);
    expect(spuriousPolicy.json().code).toBe('conflict');
  });

  it('cascade removes the whole subtree bottom-up', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const root = await createTask(dana.token, projectId, { name: 'Root' });
    const child = await createTask(dana.token, projectId, { parentId: root.id });
    const grandchild = await createTask(dana.token, projectId, { parentId: child.id });
    const survivor = await createTask(dana.token, projectId, { name: 'Survivor' });

    const response = await remove(dana.token, projectId, root.id, { childPolicy: 'cascade' });
    expect(response.statusCode, response.body).toBe(204);

    const { rows } = await exec.query<{ id: string }>(`SELECT id FROM task WHERE project_id = $1`, [
      projectId,
    ]);
    expect(rows.map((row) => row.id)).toEqual([survivor.id]);

    for (const gone of [root, child, grandchild]) {
      const audit = await auditRows(projectId, gone.id);
      expect(audit.map((row) => row.action)).toContain('delete');
    }
  });

  it('reparentToGrandparent promotes the children and renumbers them', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const grandparent = await createTask(dana.token, projectId, { name: 'Grandparent' });
    const doomed = await createTask(dana.token, projectId, {
      parentId: grandparent.id,
      name: 'Doomed',
    });
    const sibling = await createTask(dana.token, projectId, {
      parentId: grandparent.id,
      name: 'Sibling',
    });
    const childA = await createTask(dana.token, projectId, { parentId: doomed.id, name: 'A' });
    const childB = await createTask(dana.token, projectId, { parentId: doomed.id, name: 'B' });
    expect([doomed.wbsCode, sibling.wbsCode, childA.wbsCode, childB.wbsCode]).toEqual([
      '1.1',
      '1.2',
      '1.1.1',
      '1.1.2',
    ]);

    const response = await remove(dana.token, projectId, doomed.id, {
      childPolicy: 'reparentToGrandparent',
    });
    expect(response.statusCode, response.body).toBe(204);

    // The promoted children take the deleted task's place in the sibling order.
    expect((await readTask(dana.token, projectId, childA.id)).parentId).toBe(grandparent.id);
    expect((await readTask(dana.token, projectId, childA.id)).wbsCode).toBe('1.1');
    expect((await readTask(dana.token, projectId, childB.id)).wbsCode).toBe('1.2');
    expect((await readTask(dana.token, projectId, sibling.id)).wbsCode).toBe('1.3');

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task WHERE id = $1`,
      [doomed.id],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('promotes children to the top level when the deleted task had no parent', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const root = await createTask(dana.token, projectId, { name: 'Root' });
    const child = await createTask(dana.token, projectId, { parentId: root.id, name: 'Child' });

    expect(
      (await remove(dana.token, projectId, root.id, { childPolicy: 'reparentToGrandparent' }))
        .statusCode,
    ).toBe(204);

    const promoted = await readTask(dana.token, projectId, child.id);
    expect(promoted.parentId).toBeNull();
    expect(promoted.wbsCode).toBe('1');
  });

  it('rolls the surviving ancestors up after a delete', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Parent' });
    const early = await createTask(dana.token, projectId, {
      parentId: parent.id,
      start: '2026-09-01T00:00:00.000Z',
      durationHours: 24,
    });
    await createTask(dana.token, projectId, {
      parentId: parent.id,
      start: '2026-10-01T00:00:00.000Z',
      durationHours: 24,
    });
    expect((await readTask(dana.token, projectId, parent.id)).start).toBe(
      '2026-09-01T00:00:00.000Z',
    );

    expect((await remove(dana.token, projectId, early.id)).statusCode).toBe(204);
    expect((await readTask(dana.token, projectId, parent.id)).start).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});

// ------------------------------------------------------------------------------------------------
// FR-ACL-04 / FR-ACL-05 / invariant 3
// ------------------------------------------------------------------------------------------------

describe('FR-ACL: RBAC on every task mutation', () => {
  interface Fixture {
    readonly adminToken: string;
    readonly projectId: string;
    readonly tokens: Record<string, string>;
    readonly taskId: string;
    readonly otherTaskId: string;
  }

  async function fixture(): Promise<Fixture> {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const tokens: Record<string, string> = {};
    for (const role of ['editor', 'contributor', 'viewer']) {
      const userId = await addOrgUser(`${role} user`, `${role}@acme.test`);
      const invite = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/members`,
        headers: { authorization: `Bearer ${dana.token}` },
        payload: { email: `${role}@acme.test`, role },
      });
      expect(invite.statusCode).toBe(201);
      tokens[role] = await sessionFor(userId);
    }

    const task = await createTask(dana.token, projectId, { name: 'Existing' });
    const other = await createTask(dana.token, projectId, { name: 'Other' });
    return { adminToken: dana.token, projectId, tokens, taskId: task.id, otherTaskId: other.id };
  }

  /**
   * A Contributor holds `task:update:assigned` but no assignment exists in P1 (assignment CRUD is
   * P4), so the row-level condition can never be satisfied and every task mutation is refused. A
   * Viewer holds nothing that mutates at all (FR-ACL-05).
   */
  for (const role of ['contributor', 'viewer']) {
    it(`${role} is refused 403 on every task mutation`, async () => {
      const f = await fixture();
      const token = f.tokens[role]!;

      const create = await post(token, f.projectId, { name: 'Nope' });
      expect(create.statusCode, 'create').toBe(403);

      const update = await patch(token, f.projectId, f.taskId, { pctComplete: 10 });
      expect(update.statusCode, 'update').toBe(403);

      const move = await reparent(token, f.projectId, f.taskId, { newParentId: f.otherTaskId });
      expect(move.statusCode, 'reparent').toBe(403);

      const destroy = await remove(token, f.projectId, f.taskId);
      expect(destroy.statusCode, 'delete').toBe(403);

      // A denied mutation leaves neither state nor an audit trail behind.
      const { rows } = await exec.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM task WHERE project_id = $1`,
        [f.projectId],
      );
      expect(rows[0]!.count).toBe('2');
    });

    it(`${role} can still read the task list`, async () => {
      const f = await fixture();
      const response = await app.inject({
        method: 'GET',
        url: `/projects/${f.projectId}/tasks`,
        headers: { authorization: `Bearer ${f.tokens[role]}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().tasks).toHaveLength(2);
    });
  }

  it('a Contributor is refused even for a field their role may write', async () => {
    const f = await fixture();
    // `notes` is in CONTRIBUTOR_WRITABLE_TASK_FIELDS; the refusal is the row-level assignment
    // check, not the field check, and it must not be mistaken for the field check passing.
    const response = await patch(f.tokens['contributor']!, f.projectId, f.taskId, {
      notes: 'progress update',
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('forbidden');
  });

  for (const role of ['admin', 'editor'] as const) {
    it(`${role} may create, update, reparent and delete`, async () => {
      const f = await fixture();
      const token = role === 'admin' ? f.adminToken : f.tokens['editor']!;

      const created = await post(token, f.projectId, { name: 'By ' + role });
      expect(created.statusCode, 'create').toBe(201);
      const createdId = created.json().task.id as string;

      const updated = await patch(token, f.projectId, createdId, { name: 'Renamed', priority: 10 });
      expect(updated.statusCode, 'update').toBe(200);
      expect(updated.json().task.priority).toBe(10);

      const moved = await reparent(token, f.projectId, createdId, { newParentId: f.taskId });
      expect(moved.statusCode, 'reparent').toBe(200);

      const destroyed = await remove(token, f.projectId, createdId);
      expect(destroyed.statusCode, 'delete').toBe(204);
    });
  }

  it('an unauthenticated caller cannot touch the task surface', async () => {
    const f = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/projects/${f.projectId}/tasks`,
      payload: { parentId: null, name: 'x', durationHours: 1, start: null },
    });
    expect(response.statusCode).toBe(401);
  });

  it('FR-AUTH-04: a non-member gets not_found rather than forbidden', async () => {
    const f = await fixture();
    const outsiderId = await addOrgUser('Outsider', 'outsider@acme.test');
    const outsiderToken = await sessionFor(outsiderId);

    const response = await post(outsiderToken, f.projectId, { name: 'x' });
    expect(response.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------
// `status` (FR-VIEW-06's Kanban column key, but a plain task attribute independent of scheduling)
// travels through updateTaskIntentSchema alongside notes/actualStart/actualFinish — resolved by
// tech-lead: it is not schedule-affecting, so it rides the single write path for the same reason
// those fields do (one path, one audit choke point), not because Kanban itself is in scope here.
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-01: status is a plain writable field, independent of scheduling', () => {
  it('accepts a status update and persists it', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const task = await createTask(dana.token, projectId);

    const response = await patch(dana.token, projectId, task.id, { status: 'in_progress' });
    expect(response.statusCode, response.body).toBe(200);

    const { rows } = await exec.query<{ status: string }>(`SELECT status FROM task WHERE id = $1`, [
      task.id,
    ]);
    expect(rows[0]!.status).toBe('in_progress');
  });

  it('does not require children to be absent — status is never rollup-derived', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id, name: 'child' });

    const response = await patch(dana.token, projectId, parent.id, { status: 'blocked' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().task.status).toBe('blocked');
  });
});

// ------------------------------------------------------------------------------------------------
// P1 review additions. Everything below was written during the independent P1 review; each block
// covers a requirement the merged suite claimed but did not actually exercise, or pins behaviour
// that a later phase could change silently.
// ------------------------------------------------------------------------------------------------

describe('FR-TSK-03: all three rollup-owned fields are refused symmetrically', () => {
  // The original suite only covered `pctComplete`. `start` and `durationHours` are equally
  // rollup-derived, and before tech-lead's fix they were accepted, overwritten by
  // `recomputeChain` and reported back correctly in the same response — a 200 whose body silently
  // disagreed with what was PATCHed. These cases are what stops that asymmetry coming back.
  for (const [field, value] of [
    ['start', '2026-10-01T00:00:00.000Z'],
    ['durationHours', 99],
    ['pctComplete', 40],
  ] as const) {
    it(`refuses a direct ${field} edit on a summary task and names the field`, async () => {
      const dana = await register('Dana', 'dana@acme.test');
      const projectId = await createProject(dana.token);
      const parent = await createTask(dana.token, projectId, { name: 'Phase' });
      const child = await createTask(dana.token, projectId, {
        parentId: parent.id,
        start: '2026-09-05T00:00:00.000Z',
        durationHours: 24,
      });
      const rolledBefore = await readTask(dana.token, projectId, parent.id);

      const response = await patch(dana.token, projectId, parent.id, { [field]: value });
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json().code).toBe('validation_failed');
      expect(Object.keys(response.json().details.fieldErrors)).toEqual([field]);

      // Refused means refused: the summary task is untouched and nothing was audited for it.
      const rolledAfter = await readTask(dana.token, projectId, parent.id);
      expect(rolledAfter).toEqual(rolledBefore);
      expect(
        (await auditRows(projectId, parent.id)).filter((row) => row.action === 'update'),
      ).toHaveLength(1); // the one rollup update from creating the child, and no more

      // The same field on the leaf is accepted — this is a rule about summary tasks, not fields.
      expect(
        (await patch(dana.token, projectId, child.id, { [field]: value })).statusCode,
        `leaf ${field}`,
      ).toBe(200);
    });
  }

  it('names every rollup-owned field when a PATCH mixes several of them', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id });

    const response = await patch(dana.token, projectId, parent.id, {
      start: '2026-10-01T00:00:00.000Z',
      durationHours: 12,
      pctComplete: 5,
      name: 'Also renamed',
    });
    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.json().details.fieldErrors).sort()).toEqual([
      'durationHours',
      'pctComplete',
      'start',
    ]);
    // Refused whole, not partially applied: the name did not change either.
    expect((await readTask(dana.token, projectId, parent.id)).name).toBe('Task');
  });
});

describe('FR-TSK-04: a milestone cannot become a summary task by any route', () => {
  // `assertNotMilestoneParent` guards create-under and reparent-under; `applyUpdate` guards
  // flipping an existing summary task into a milestone. Only the first had a test.
  async function milestoneFixture() {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const milestone = await createTask(dana.token, projectId, {
      name: 'Sign-off',
      isMilestone: true,
      durationHours: 0,
    });
    return { dana, projectId, milestone };
  }

  it('refuses creating a child under a milestone', async () => {
    const { dana, projectId, milestone } = await milestoneFixture();
    const response = await post(dana.token, projectId, { parentId: milestone.id, name: 'Child' });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().message).toBe('A milestone cannot be a summary task');
  });

  it('refuses reparenting an existing task under a milestone', async () => {
    const { dana, projectId, milestone } = await milestoneFixture();
    const other = await createTask(dana.token, projectId, { name: 'Other' });

    const response = await reparent(dana.token, projectId, other.id, {
      newParentId: milestone.id,
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json().message).toBe('A milestone cannot be a summary task');

    // The refused move left both tasks exactly where they were, WBS codes included.
    expect((await readTask(dana.token, projectId, other.id)).parentId).toBeNull();
    expect((await readTask(dana.token, projectId, other.id)).wbsCode).toBe('2');
    expect((await readTask(dana.token, projectId, milestone.id)).durationHours).toBe(0);
  });

  it('refuses turning a task that already has children into a milestone', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id });

    const response = await patch(dana.token, projectId, parent.id, {
      isMilestone: true,
      durationHours: 0,
    });
    expect(response.statusCode, response.body).toBe(422);
    expect((await readTask(dana.token, projectId, parent.id)).isMilestone).toBe(false);
  });
});

describe('FR-TSK-02: WBS renumbering never collides on UNIQUE (project_id, wbs_code)', () => {
  /** Every WBS code in the project, and the parent each belongs to. */
  async function wbsSnapshot(projectId: string): Promise<Map<string, string>> {
    const { rows } = await exec.query<{ id: string; wbs_code: string }>(
      `SELECT id, wbs_code FROM task WHERE project_id = $1`,
      [projectId],
    );
    return new Map(rows.map((row) => [row.id, row.wbs_code]));
  }

  /**
   * The structural invariants a renumber must preserve: codes are unique, and a child's code is
   * its parent's code plus one segment. The second half is what makes the first meaningful — a
   * set of unique but wrong codes would still pass a uniqueness check on its own.
   */
  async function assertWbsConsistent(projectId: string): Promise<void> {
    const { rows } = await exec.query<{ id: string; parent_id: string | null; wbs_code: string }>(
      `SELECT id, parent_id, wbs_code FROM task WHERE project_id = $1`,
      [projectId],
    );
    const codes = rows.map((row) => row.wbs_code);
    expect(new Set(codes).size, `duplicate WBS codes: ${codes.join(', ')}`).toBe(codes.length);
    expect(
      codes.some((code) => code.startsWith('~')),
      'a parking code was left behind',
    ).toBe(false);

    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const row of rows) {
      if (row.parent_id === null) {
        expect(row.wbs_code, `${row.wbs_code} is top level`).not.toContain('.');
        continue;
      }
      const parent = byId.get(row.parent_id);
      expect(parent, `parent of ${row.wbs_code} is outside the project`).toBeDefined();
      expect(row.wbs_code.slice(0, row.wbs_code.lastIndexOf('.'))).toBe(parent!.wbs_code);
    }
  }

  it('reorders siblings under the same parent — the case where old and new codes overlap', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase' });
    const a = await createTask(dana.token, projectId, { parentId: parent.id, name: 'A' });
    const b = await createTask(dana.token, projectId, { parentId: parent.id, name: 'B' });
    const c = await createTask(dana.token, projectId, { parentId: parent.id, name: 'C' });
    // Each sibling carries a subtree, so the recursive half of the renumber is exercised too.
    const a1 = await createTask(dana.token, projectId, { parentId: a.id, name: 'A1' });
    const c1 = await createTask(dana.token, projectId, { parentId: c.id, name: 'C1' });
    expect([a.wbsCode, b.wbsCode, c.wbsCode, a1.wbsCode, c1.wbsCode]).toEqual([
      '1.1',
      '1.2',
      '1.3',
      '1.1.1',
      '1.3.1',
    ]);

    // C moves to the front of its own sibling list. 1.3 -> 1.1 while 1.1 still exists is exactly
    // the mid-statement collision the park-then-assign pass exists to avoid.
    const response = await reparent(dana.token, projectId, c.id, {
      newParentId: parent.id,
      newIndex: 0,
    });
    expect(response.statusCode, response.body).toBe(200);

    await assertWbsConsistent(projectId);
    expect((await readTask(dana.token, projectId, c.id)).wbsCode).toBe('1.1');
    expect((await readTask(dana.token, projectId, c1.id)).wbsCode).toBe('1.1.1');
    expect((await readTask(dana.token, projectId, a.id)).wbsCode).toBe('1.2');
    expect((await readTask(dana.token, projectId, a1.id)).wbsCode).toBe('1.2.1');
    expect((await readTask(dana.token, projectId, b.id)).wbsCode).toBe('1.3');
  });

  it('stays consistent across a long random sequence of moves and deletes', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    // A deterministic pseudo-random walk: same seed, same sequence, so a failure is reproducible
    // by re-running rather than by luck. (The CPM property suite in P2 gets the real generator;
    // this is the WBS-renumbering half of the same idea, which is what P1 actually ships.)
    let seed = 20260816;
    const next = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const parentId = ids.length === 0 ? null : (ids[next(ids.length)] ?? null);
      const created = await post(dana.token, projectId, {
        parentId,
        name: `T${index}`,
      });
      // A milestone parent or a since-deleted parent is a legitimate refusal, not a failure.
      if (created.statusCode === 201) ids.push(created.json().task.id as string);
    }
    await assertWbsConsistent(projectId);

    for (let step = 0; step < 40; step += 1) {
      const alive = (
        await exec.query<{ id: string }>(`SELECT id FROM task WHERE project_id = $1`, [projectId])
      ).rows.map((row) => row.id);
      if (alive.length < 2) break;

      const subject = alive[next(alive.length)]!;
      if (step % 4 === 3) {
        await remove(dana.token, projectId, subject, { childPolicy: 'reparentToGrandparent' });
        await remove(dana.token, projectId, subject, {});
      } else {
        const target = next(2) === 0 ? null : alive[next(alive.length)]!;
        await reparent(dana.token, projectId, subject, { newParentId: target });
      }
      // Whatever the endpoint answered — 200, 404, 409 or 422 — the tree must still be sane.
      await assertWbsConsistent(projectId);
    }

    expect((await wbsSnapshot(projectId)).size).toBeGreaterThan(0);
  });
});

describe('FR-TSK-08: reparentToGrandparent with depth below the promoted children', () => {
  it('rewrites the whole promoted subtree, not just the promoted row', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const grandparent = await createTask(dana.token, projectId, { name: 'GP' });
    const doomed = await createTask(dana.token, projectId, {
      parentId: grandparent.id,
      name: 'Doomed',
    });
    const sibling = await createTask(dana.token, projectId, {
      parentId: grandparent.id,
      name: 'Sibling',
    });
    const promoted = await createTask(dana.token, projectId, {
      parentId: doomed.id,
      name: 'Promoted',
    });
    const deep = await createTask(dana.token, projectId, {
      parentId: promoted.id,
      name: 'Deep',
    });
    const siblingChild = await createTask(dana.token, projectId, {
      parentId: sibling.id,
      name: 'Sibling child',
    });
    expect([promoted.wbsCode, deep.wbsCode]).toEqual(['1.1.1', '1.1.1.1']);

    const response = await remove(dana.token, projectId, doomed.id, {
      childPolicy: 'reparentToGrandparent',
    });
    expect(response.statusCode, response.body).toBe(204);

    expect((await readTask(dana.token, projectId, promoted.id)).wbsCode).toBe('1.1');
    // The grandchild followed its parent up a level — a renumber that stopped at the promoted
    // row itself would leave this one at 1.1.1.1 and orphan it from its own parent's code.
    expect((await readTask(dana.token, projectId, deep.id)).wbsCode).toBe('1.1.1');
    expect((await readTask(dana.token, projectId, deep.id)).parentId).toBe(promoted.id);
    expect((await readTask(dana.token, projectId, sibling.id)).wbsCode).toBe('1.2');
    expect((await readTask(dana.token, projectId, siblingChild.id)).wbsCode).toBe('1.2.1');
  });

  it('promotes a multi-level subtree to the top level when the deleted task had no parent', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const root = await createTask(dana.token, projectId, { name: 'Root' });
    const child = await createTask(dana.token, projectId, { parentId: root.id, name: 'Child' });
    const grandchild = await createTask(dana.token, projectId, {
      parentId: child.id,
      name: 'Grandchild',
    });
    const untouched = await createTask(dana.token, projectId, { name: 'Untouched' });

    // The "grandparent" here is null: the promoted children become top-level tasks.
    expect(
      (await remove(dana.token, projectId, root.id, { childPolicy: 'reparentToGrandparent' }))
        .statusCode,
    ).toBe(204);

    expect((await readTask(dana.token, projectId, child.id)).parentId).toBeNull();
    expect((await readTask(dana.token, projectId, child.id)).wbsCode).toBe('1');
    expect((await readTask(dana.token, projectId, grandchild.id)).wbsCode).toBe('1.1');
    expect((await readTask(dana.token, projectId, untouched.id)).wbsCode).toBe('2');

    // Each promoted row is audited in its own right — the parent change and the WBS change are
    // both schedule-affecting (invariant 4).
    for (const moved of [child, grandchild]) {
      expect((await auditRows(projectId, moved.id)).map((row) => row.action)).toContain('update');
    }
    expect((await auditRows(projectId, root.id)).map((row) => row.action)).toContain('delete');
  });

  it('cascade audits every row in a three-level subtree with its own before-image', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const root = await createTask(dana.token, projectId, { name: 'Root' });
    const child = await createTask(dana.token, projectId, { parentId: root.id, name: 'Child' });
    const grandchild = await createTask(dana.token, projectId, {
      parentId: child.id,
      name: 'Grandchild',
    });

    expect(
      (await remove(dana.token, projectId, root.id, { childPolicy: 'cascade' })).statusCode,
    ).toBe(204);

    for (const gone of [root, child, grandchild]) {
      const deletes = (await auditRows(projectId, gone.id)).filter(
        (row) => row.action === 'delete',
      );
      expect(deletes, `${gone.name} delete audit`).toHaveLength(1);
      // A delete row carries the row as it was — a null before-image would record nothing.
      expect((deletes[0]!.before_json as { name: string }).name).toBe(gone.name);
    }
  });
});

describe('FR-TSK-03 / FR-TRK-04: a subtree of nothing but milestones', () => {
  it('rolls up to a plain mean without producing NaN, and the database accepts it', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase' });
    const first = await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'M1',
      isMilestone: true,
      durationHours: 0,
      start: '2026-09-08T00:00:00.000Z',
    });
    await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'M2',
      isMilestone: true,
      durationHours: 0,
      start: '2026-09-09T00:00:00.000Z',
    });

    // Duration weighting would divide by zero here; the fallback is a plain mean of 100 and 0.
    expect((await patch(dana.token, projectId, first.id, { pctComplete: 100 })).statusCode).toBe(
      200,
    );

    const rolled = await readTask(dana.token, projectId, parent.id);
    expect(Number.isNaN(rolled.pctComplete)).toBe(false);
    expect(rolled.pctComplete).toBe(50);
    expect(rolled.start).toBe('2026-09-08T00:00:00.000Z');
    expect(rolled.finish).toBe('2026-09-09T00:00:00.000Z');
    expect(rolled.durationHours).toBe(24);

    // `pct_complete BETWEEN 0 AND 100` would have rejected a NaN, so the row's own existence is
    // half the assertion; read it straight from the column rather than through the DTO.
    const { rows } = await exec.query<{ pct_complete: number }>(
      `SELECT pct_complete FROM task WHERE id = $1`,
      [parent.id],
    );
    expect(rows[0]!.pct_complete).toBe(50);
  });

  it('handles a single milestone child, where the parent span is zero hours', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId, { name: 'Phase' });
    const only = await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'M1',
      isMilestone: true,
      durationHours: 0,
      start: '2026-09-08T00:00:00.000Z',
    });

    const rolled = await readTask(dana.token, projectId, parent.id);
    expect(rolled.durationHours).toBe(0);
    expect(rolled.start).toBe(rolled.finish);
    expect(rolled.isMilestone).toBe(false); // zero duration does not make the parent a milestone

    expect((await patch(dana.token, projectId, only.id, { pctComplete: 70 })).statusCode).toBe(200);
    expect((await readTask(dana.token, projectId, parent.id)).pctComplete).toBe(70);
  });
});

describe('FR-COL-07 / invariant 4: one audit row per ancestor a rollup moved', () => {
  it('writes three distinct update rows for a leaf edit three levels down', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const great = await createTask(dana.token, projectId, { name: 'Programme' });
    const grand = await createTask(dana.token, projectId, {
      parentId: great.id,
      name: 'Phase',
    });
    const parent = await createTask(dana.token, projectId, {
      parentId: grand.id,
      name: 'Work package',
    });
    const leaf = await createTask(dana.token, projectId, {
      parentId: parent.id,
      name: 'Task',
      start: '2026-09-05T00:00:00.000Z',
      durationHours: 8,
    });

    const auditedBefore = (await auditRows(projectId)).length;
    const moved = await patch(dana.token, projectId, leaf.id, {
      start: '2026-10-01T00:00:00.000Z',
      durationHours: 48,
    });
    expect(moved.statusCode, moved.body).toBe(200);

    const written = (await auditRows(projectId)).slice(auditedBefore);
    // The leaf plus each of its three ancestors — no more (no duplicate row per ancestor) and
    // no fewer (the great-grandparent is not dropped as "far enough away").
    expect(written).toHaveLength(4);
    expect(new Set(written.map((row) => row.entity_id))).toEqual(
      new Set([leaf.id, parent.id, grand.id, great.id]),
    );
    expect(written.every((row) => row.action === 'update')).toBe(true);

    const { rows } = await exec.query<{
      entity_id: string;
      before_json: { start: string; finish: string };
      after_json: { start: string; finish: string };
    }>(
      `SELECT entity_id, before_json, after_json FROM audit_log_entry
        WHERE project_id = $1 AND entity_type = 'task' AND action = 'update'
        ORDER BY created_at DESC LIMIT 4`,
      [projectId],
    );
    for (const row of rows) {
      // Each ancestor's row records that ancestor's own dates moving, not the leaf's.
      expect(row.before_json.start, `${row.entity_id} before`).not.toBe(row.after_json.start);
      expect(row.after_json.start).toBe('2026-10-01T00:00:00.000Z');
      expect(row.after_json.finish).toBe('2026-10-03T00:00:00.000Z');
    }
  });

  it('audits nothing at all when the mutation is refused', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const parent = await createTask(dana.token, projectId);
    await createTask(dana.token, projectId, { parentId: parent.id });
    const before = (await auditRows(projectId)).length;

    expect((await patch(dana.token, projectId, parent.id, { durationHours: 4 })).statusCode).toBe(
      422,
    );
    expect((await auditRows(projectId)).length).toBe(before);
  });
});

describe('FR-TSK-05, FR-TSK-06, FR-TSK-07: the per-task scheduling attributes round-trip', () => {
  it('FR-TSK-05: scheduleMode is writable and persists', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const task = await createTask(dana.token, projectId);
    expect(task.scheduleMode).toBe('auto');

    const response = await patch(dana.token, projectId, task.id, { scheduleMode: 'manual' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().task.scheduleMode).toBe('manual');
    expect((await readTask(dana.token, projectId, task.id)).scheduleMode).toBe('manual');
  });

  it('FR-TSK-06: every constraint type in the contract is accepted with its correct date shape', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    // All eight of FR-TSK-06's types, not just the two the original suite probed. P1 stores them;
    // enforcing them against the schedule is FR-SCH-05 and belongs to the CPM engine in P2.
    for (const constraintType of ['ASAP', 'ALAP'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${dana.token}` },
        payload: {
          parentId: null,
          name: constraintType,
          durationHours: 8,
          start: null,
          constraintType,
          constraintDate: null,
        },
      });
      expect(response.statusCode, `${constraintType}: ${response.body}`).toBe(201);
      expect(response.json().task.constraintType).toBe(constraintType);
      expect(response.json().task.constraintDate).toBeNull();
    }

    for (const constraintType of ['MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${dana.token}` },
        payload: {
          parentId: null,
          name: constraintType,
          durationHours: 8,
          start: null,
          constraintType,
          constraintDate: '2026-10-01T00:00:00.000Z',
        },
      });
      expect(response.statusCode, `${constraintType}: ${response.body}`).toBe(201);
      expect(response.json().task.constraintType).toBe(constraintType);
      expect(response.json().task.constraintDate).toBe('2026-10-01T00:00:00.000Z');

      // And the same type without its date is refused, for every one of the six.
      const missing = await app.inject({
        method: 'POST',
        url: `/projects/${projectId}/tasks`,
        headers: { authorization: `Bearer ${dana.token}` },
        payload: {
          parentId: null,
          name: `${constraintType} bad`,
          durationHours: 8,
          start: null,
          constraintType,
        },
      });
      expect(missing.statusCode, `${constraintType} without a date`).toBe(422);
    }
  });

  it('FR-TSK-07: a calendar override from this project is accepted and persists', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const created = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/calendars`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        name: 'Night shift',
        workingDays: [1, 2, 3, 4, 5],
        workingHoursStartMinute: 20 * 60,
        workingHoursEndMinute: 23 * 60,
      },
    });
    expect(created.statusCode).toBe(201);
    const calendarId = created.json().calendar.id as string;

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: { parentId: null, name: 'Night work', durationHours: 8, start: null, calendarId },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().task.calendarId).toBe(calendarId);

    // And it can be cleared again.
    const cleared = await patch(dana.token, projectId, response.json().task.id, {
      calendarId: null,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json().task.calendarId).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------
// FR-AUTH-04 for the *new* P1 endpoints. The original suite proved a non-member gets 404; these
// prove that a legitimate member of project B cannot use B's endpoints to touch, or to detect, an
// id that lives in project A. That is the half where an id oracle would actually appear.
// ------------------------------------------------------------------------------------------------

describe('FR-AUTH-04: task and calendar ids do not leak across a project boundary', () => {
  const GHOST_ID = '00000000-0000-4000-8000-000000000000';

  async function twoProjects() {
    const dana = await register('Dana', 'dana@acme.test');
    const alpha = await createProject(dana.token);
    const beta = await createProject(dana.token);
    const taskInAlpha = await createTask(dana.token, alpha, { name: 'Secret' });
    return { dana, alpha, beta, taskInAlpha };
  }

  it("answers 404 — identical to a ghost id — for another project's task on every mutating route", async () => {
    const { dana, alpha, beta, taskInAlpha } = await twoProjects();

    const real = [
      await patch(dana.token, beta, taskInAlpha.id, { name: 'Hijacked' }),
      await reparent(dana.token, beta, taskInAlpha.id, { newParentId: null }),
      await remove(dana.token, beta, taskInAlpha.id),
    ];
    const ghost = [
      await patch(dana.token, beta, GHOST_ID, { name: 'Hijacked' }),
      await reparent(dana.token, beta, GHOST_ID, { newParentId: null }),
      await remove(dana.token, beta, GHOST_ID),
    ];

    for (let index = 0; index < real.length; index += 1) {
      expect(real[index]!.statusCode, `real id, route ${index}`).toBe(404);
      // Byte-identical apart from the request id: an existing-elsewhere id and an id that has
      // never existed must be indistinguishable to the caller.
      expect(real[index]!.json().code).toBe(ghost[index]!.json().code);
      expect(real[index]!.json().message).toBe(ghost[index]!.json().message);
    }

    // The task in the other project is untouched by all of that.
    const survivor = await readTask(dana.token, alpha, taskInAlpha.id);
    expect(survivor.name).toBe('Secret');
    expect(survivor.wbsCode).toBe('1');
  });

  it("refuses another project's task as a parent, on both create and reparent", async () => {
    const { dana, beta, taskInAlpha } = await twoProjects();
    const taskInBeta = await createTask(dana.token, beta, { name: 'Local' });

    const created = await post(dana.token, beta, { parentId: taskInAlpha.id, name: 'Child' });
    expect(created.statusCode, created.body).toBe(404);
    expect(created.json().code).toBe('not_found');

    const moved = await reparent(dana.token, beta, taskInBeta.id, {
      newParentId: taskInAlpha.id,
    });
    expect(moved.statusCode, moved.body).toBe(404);
    expect((await readTask(dana.token, beta, taskInBeta.id)).parentId).toBeNull();
  });

  /**
   * `task.calendar_id` is a bare `REFERENCES calendar (id)`: the database cannot say "and it must
   * be a calendar of this project". Before this was checked in `applyTaskIntent`, a caller could
   * attach any calendar in the installation — including one belonging to a different organization
   * — to their own task, and the two failure modes differed (201 for a real foreign id, 500 for an
   * unused one), which made the endpoint an existence oracle for calendar ids.
   */
  it('refuses a calendar id from another project, on create and on update', async () => {
    const { dana, alpha, beta } = await twoProjects();
    const alphaCalendar = (
      await app.inject({
        method: 'GET',
        url: `/projects/${alpha}`,
        headers: { authorization: `Bearer ${dana.token}` },
      })
    ).json().project.calendarId as string;

    const created = await post(dana.token, beta, { name: 'x' });
    const onCreate = await app.inject({
      method: 'POST',
      url: `/projects/${beta}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        parentId: null,
        name: 'Borrowed calendar',
        durationHours: 8,
        start: null,
        calendarId: alphaCalendar,
      },
    });
    expect(onCreate.statusCode, onCreate.body).toBe(404);

    const onUpdate = await patch(dana.token, beta, created.json().task.id, {
      calendarId: alphaCalendar,
    });
    expect(onUpdate.statusCode, onUpdate.body).toBe(404);
    expect((await readTask(dana.token, beta, created.json().task.id)).calendarId).toBeNull();
  });

  it('refuses a calendar id that belongs to another organization', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const danaProject = await createProject(dana.token);

    // A wholly separate tenant. `register` creates its own organization.
    const evan = await register('Evan', 'evan@other.test');
    const evanProject = await createProject(evan.token);
    const evanCalendar = (
      await app.inject({
        method: 'GET',
        url: `/projects/${evanProject}`,
        headers: { authorization: `Bearer ${evan.token}` },
      })
    ).json().project.calendarId as string;

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${danaProject}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        parentId: null,
        name: 'Cross-tenant',
        durationHours: 8,
        start: null,
        calendarId: evanCalendar,
      },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('not_found');
  });

  it('answers 404, not 500, for a calendar id that exists nowhere', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/tasks`,
      headers: { authorization: `Bearer ${dana.token}` },
      payload: {
        parentId: null,
        name: 'Ghost calendar',
        durationHours: 8,
        start: null,
        calendarId: GHOST_ID,
      },
    });
    // A foreign-key violation rendered as an internal error both leaks the shape of the schema
    // and distinguishes "unused id" from "id owned by someone else".
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json().code).toBe('not_found');
  });
});

// ------------------------------------------------------------------------------------------------
// FR-ACL-04 tripwire for P4. `task:update:assigned` has no reachable Contributor path in P1
// because `assignment` is necessarily empty until P4 (FR-RES-03) — verified by reading
// `assertAssignedRowLevel`, which refuses unconditionally for any role lacking `task:update:any`.
// These cases pin that so the behaviour cannot change unnoticed when assignments arrive.
// ------------------------------------------------------------------------------------------------

describe('FR-ACL-04: a Contributor is refused on every task mutation in P1', () => {
  async function contributorToken(projectId: string, adminToken: string): Promise<string> {
    const userId = await addOrgUser('Cara', 'cara@acme.test');
    const invite = await app.inject({
      method: 'POST',
      url: `/projects/${projectId}/members`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email: 'cara@acme.test', role: 'contributor' },
    });
    expect(invite.statusCode).toBe(201);
    return sessionFor(userId);
  }

  it('refuses every field the role is nominally allowed to write, one at a time', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const task = await createTask(dana.token, projectId);
    const token = await contributorToken(projectId, dana.token);

    // Every member of CONTRIBUTOR_WRITABLE_TASK_FIELDS. `canWriteTaskField` says yes to all five;
    // the row-level assignment check is what refuses them, and it must refuse all five today.
    const writable: Array<[string, unknown]> = [
      ['pctComplete', 25],
      ['actualStart', '2026-09-02T08:00:00.000Z'],
      ['actualFinish', '2026-09-03T08:00:00.000Z'],
      ['notes', 'on track'],
      ['status', 'in_progress'],
    ];
    for (const [field, value] of writable) {
      const response = await patch(token, projectId, task.id, { [field]: value });
      // If this starts failing, P4 has made the assignment path reachable. That is a real product
      // change: re-read `assertAssignedRowLevel` and decide deliberately, do not just relax it.
      expect(response.statusCode, `contributor PATCH ${field}`).toBe(403);
      expect(response.json().code).toBe('forbidden');
    }

    const unchanged = await readTask(dana.token, projectId, task.id);
    expect(unchanged.pctComplete).toBe(0);
    expect(unchanged.status).toBe('not_started');
  });

  it('refuses a field outside the role field set with the field-scoping error, not the row one', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const task = await createTask(dana.token, projectId);
    const token = await contributorToken(projectId, dana.token);

    // `assertFieldsWritable` runs first, so a structural field is named in the message. The two
    // refusals are different rules and should stay distinguishable in the response.
    const response = await patch(token, projectId, task.id, { durationHours: 4 });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('durationHours');

    const mixed = await patch(token, projectId, task.id, { notes: 'ok', durationHours: 4 });
    expect(mixed.statusCode).toBe(403);
    expect(mixed.json().message).toContain('durationHours');
    expect((await readTask(dana.token, projectId, task.id)).notes).toBe('');
  });
});
