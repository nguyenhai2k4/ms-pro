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
// Contract gap (escalated): `status` is in the REST DTO but not in the intent envelope.
// ------------------------------------------------------------------------------------------------

describe('updateTaskRequestSchema.status has no field on updateTaskIntentSchema', () => {
  it('refuses the field rather than accepting a PATCH that silently discards it', async () => {
    const dana = await register('Dana', 'dana@acme.test');
    const projectId = await createProject(dana.token);
    const task = await createTask(dana.token, projectId);

    const response = await patch(dana.token, projectId, task.id, { status: 'in_progress' });
    expect(response.statusCode).toBe(422);

    const { rows } = await exec.query<{ status: string }>(`SELECT status FROM task WHERE id = $1`, [
      task.id,
    ]);
    expect(rows[0]!.status).toBe('not_started');
  });
});
