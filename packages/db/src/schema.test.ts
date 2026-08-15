import { PGlite } from '@electric-sql/pglite';
import {
  ENTITY_SCHEMAS,
  auditActionSchema,
  auditEntityTypeSchema,
  authProviderSchema,
  constraintTypeSchema,
  dependencyTypeSchema,
  exportJobStatusSchema,
  exportTypeSchema,
  notificationTypeSchema,
  planTierSchema,
  projectRoleSchema,
  rateUnitSchema,
  resourceTypeSchema,
  scheduleModeSchema,
  taskStatusSchema,
} from '@projectapp/shared-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { MigrationChecksumError, applyMigrations, loadMigrationFiles } from './migrations.js';
import type { SqlExecutor } from './migrations.js';
import { migrationsDirectory } from './paths.js';
import { TABLE_BY_ENTITY } from './table-map.js';

/**
 * These tests run the real migration against an in-process PostgreSQL (PGlite, Postgres compiled
 * to WASM) — the DDL is executed, not eyeballed. Constraint tests below assert the database
 * itself rejects violations, because a check that only exists in application code is a check that
 * a future import path, a background job, or a psql session will bypass.
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

async function freshDatabase(): Promise<{ db: PGlite; exec: SqlExecutor }> {
  const db = new PGlite();
  const exec = executorFor(db);
  await applyMigrations(exec, loadMigrationFiles(migrationsDirectory));
  return { db, exec };
}

/** Seeds the minimum graph needed to insert a task. Returns the ids. */
async function seedProject(exec: SqlExecutor) {
  const org = await exec.query<{ id: string }>(
    `INSERT INTO organization (name, plan_tier) VALUES ('Acme', 'free') RETURNING id`,
  );
  const orgId = org.rows[0]!.id;

  const user = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, 'Dana PM', 'dana@acme.test', 'password') RETURNING id`,
    [orgId],
  );
  const userId = user.rows[0]!.id;

  const calendar = await exec.query<{ id: string }>(
    `INSERT INTO calendar (project_id, name, working_days, working_hours_start_minute,
                           working_hours_end_minute, is_default)
     VALUES (NULL, 'Mon-Fri', '{1,2,3,4,5}', 540, 1020, true) RETURNING id`,
  );
  const calendarId = calendar.rows[0]!.id;

  const project = await exec.query<{ id: string }>(
    `INSERT INTO project (org_id, name, start_date, calendar_id, created_by)
     VALUES ($1, 'Warehouse build', '2026-09-01T08:00:00Z', $2, $3) RETURNING id`,
    [orgId, calendarId, userId],
  );

  return { orgId, userId, calendarId, projectId: project.rows[0]!.id };
}

async function insertTask(
  exec: SqlExecutor,
  ids: { projectId: string; userId: string },
  overrides: Record<string, string> = {},
): Promise<string> {
  const columns: Record<string, string> = {
    project_id: `'${ids.projectId}'`,
    wbs_code: `'1'`,
    name: `'Excavate'`,
    duration_hours: '40',
    start: `'2026-09-01T08:00:00Z'`,
    finish: `'2026-09-08T17:00:00Z'`,
    updated_by: `'${ids.userId}'`,
    ...overrides,
  };
  const result = await exec.query<{ id: string }>(
    `INSERT INTO task (${Object.keys(columns).join(', ')})
     VALUES (${Object.values(columns).join(', ')}) RETURNING id`,
  );
  return result.rows[0]!.id;
}

describe('0001_init applies', () => {
  let exec: SqlExecutor;

  beforeAll(async () => {
    ({ exec } = await freshDatabase());
  });

  it('creates a table for every entity in the contract', async () => {
    const { rows } = await exec.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.map((row) => row.table_name));

    for (const entity of Object.keys(ENTITY_SCHEMAS)) {
      const table = TABLE_BY_ENTITY[entity as keyof typeof TABLE_BY_ENTITY];
      expect(tables.has(table), `${entity} -> missing table "${table}"`).toBe(true);
    }
  });

  it('uses snake_case for every column', async () => {
    const { rows } = await exec.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const offenders = rows.filter((row) => !/^[a-z][a-z0-9_]*$/.test(row.column_name));
    expect(offenders).toEqual([]);
  });

  it('indexes the dependency graph in both directions (FRS §6 indexing note)', async () => {
    const { rows } = await exec.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'dependency'`,
    );
    const defs = rows.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/\(predecessor_id\)/);
    expect(defs).toMatch(/\(successor_id\)/);
  });

  it('indexes the WBS tree load and the activity feed', async () => {
    const { rows } = await exec.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename IN ('task', 'audit_log_entry')`,
    );
    const defs = rows.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/\(project_id, parent_id\)/);
    expect(defs).toMatch(/audit_log_entry.*\(project_id, created_at DESC\)/s);
  });
});

describe('SQL vocabularies match the shared-types contract', () => {
  let exec: SqlExecutor;

  beforeAll(async () => {
    ({ exec } = await freshDatabase());
  });

  const cases: Array<[string, readonly string[]]> = [
    ['plan_tier', planTierSchema.options],
    ['auth_provider', authProviderSchema.options],
    ['project_role', projectRoleSchema.options],
    ['dependency_type', dependencyTypeSchema.options],
    ['constraint_type', constraintTypeSchema.options],
    ['schedule_mode', scheduleModeSchema.options],
    ['resource_type', resourceTypeSchema.options],
    ['rate_unit', rateUnitSchema.options],
    ['task_status', taskStatusSchema.options],
    ['audit_entity_type', auditEntityTypeSchema.options],
    ['audit_action', auditActionSchema.options],
    ['export_type', exportTypeSchema.options],
    ['export_job_status', exportJobStatusSchema.options],
    ['notification_type', notificationTypeSchema.options],
  ];

  it.each(cases)('%s matches its zod enum', async (typeName, expected) => {
    const { rows } = await exec.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = $1
        ORDER BY e.enumsortorder`,
      [typeName],
    );
    expect(rows.map((row) => row.label).sort()).toEqual([...expected].sort());
  });
});

describe('the database enforces the requirements, not just the application', () => {
  let exec: SqlExecutor;
  let ids: { projectId: string; userId: string; calendarId: string; orgId: string };

  beforeAll(async () => {
    ({ exec } = await freshDatabase());
    ids = await seedProject(exec);
  });

  it('accepts a well-formed task', async () => {
    const id = await insertTask(exec, ids, { wbs_code: `'1.0'` });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('FR-TSK-04: rejects a milestone with non-zero duration', async () => {
    await expect(
      insertTask(exec, ids, { wbs_code: `'1.1'`, is_milestone: 'true', duration_hours: '8' }),
    ).rejects.toThrow(/task_milestone_zero_duration/);
  });

  it('FR-TSK-06: rejects a dated constraint with no constraint_date', async () => {
    await expect(
      insertTask(exec, ids, { wbs_code: `'1.2'`, constraint_type: `'MSO'` }),
    ).rejects.toThrow(/task_constraint_date_required/);
  });

  it('FR-TSK-06: rejects ASAP carrying a constraint_date', async () => {
    await expect(
      insertTask(exec, ids, {
        wbs_code: `'1.3'`,
        constraint_type: `'ASAP'`,
        constraint_date: `'2026-09-01T08:00:00Z'`,
      }),
    ).rejects.toThrow(/task_constraint_date_required/);
  });

  it('rejects a task finishing before it starts', async () => {
    await expect(
      insertTask(exec, ids, {
        wbs_code: `'1.4'`,
        start: `'2026-09-08T08:00:00Z'`,
        finish: `'2026-09-01T08:00:00Z'`,
      }),
    ).rejects.toThrow(/task_finish_after_start/);
  });

  it('FR-SCH-03: rejects a self-dependency', async () => {
    const taskId = await insertTask(exec, ids, { wbs_code: `'2.0'` });
    await expect(
      exec.query(
        `INSERT INTO dependency (project_id, predecessor_id, successor_id, type)
         VALUES ($1, $2, $2, 'FS')`,
        [ids.projectId, taskId],
      ),
    ).rejects.toThrow(/dependency_no_self_link/);
  });

  it('FR-SCH-01/02: accepts all four link types and negative lag', async () => {
    const a = await insertTask(exec, ids, { wbs_code: `'3.0'` });
    const b = await insertTask(exec, ids, { wbs_code: `'3.1'` });
    const c = await insertTask(exec, ids, { wbs_code: `'3.2'` });
    const d = await insertTask(exec, ids, { wbs_code: `'3.3'` });
    const e = await insertTask(exec, ids, { wbs_code: `'3.4'` });

    const pairs: Array<[string, string, string]> = [
      [a, b, 'FS'],
      [a, c, 'SS'],
      [a, d, 'FF'],
      [a, e, 'SF'],
    ];
    for (const [predecessor, successor, type] of pairs) {
      await exec.query(
        `INSERT INTO dependency (project_id, predecessor_id, successor_id, type, lag_hours)
         VALUES ($1, $2, $3, $4, -16)`,
        [ids.projectId, predecessor, successor, type],
      );
    }
    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dependency WHERE predecessor_id = $1`,
      [a],
    );
    expect(rows[0]!.count).toBe('4');
  });

  it('FR-TSK-09: deleting a task removes its dependencies', async () => {
    const p = await insertTask(exec, ids, { wbs_code: `'4.0'` });
    const s = await insertTask(exec, ids, { wbs_code: `'4.1'` });
    await exec.query(
      `INSERT INTO dependency (project_id, predecessor_id, successor_id, type)
       VALUES ($1, $2, $3, 'FS')`,
      [ids.projectId, p, s],
    );
    await exec.query(`DELETE FROM task WHERE id = $1`, [p]);
    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM dependency WHERE predecessor_id = $1`,
      [p],
    );
    expect(rows[0]!.count).toBe('0');
  });

  it('FR-TSK-08: refuses to silently cascade-delete children, so the user choice stays reachable', async () => {
    const parent = await insertTask(exec, ids, { wbs_code: `'5.0'` });
    await insertTask(exec, ids, { wbs_code: `'5.1'`, parent_id: `'${parent}'` });
    await expect(exec.query(`DELETE FROM task WHERE id = $1`, [parent])).rejects.toThrow();
  });

  it('invariant 4: an audit row must carry the side its action implies', async () => {
    const taskId = await insertTask(exec, ids, { wbs_code: `'6.0'` });

    // Valid: create carries only "after".
    await exec.query(
      `INSERT INTO audit_log_entry (project_id, actor_user_id, entity_type, entity_id, action, after_json)
       VALUES ($1, $2, 'task', $3, 'create', '{"name":"Excavate"}'::jsonb)`,
      [ids.projectId, ids.userId, taskId],
    );

    // Invalid: an update with no before/after diff records nothing.
    await expect(
      exec.query(
        `INSERT INTO audit_log_entry (project_id, actor_user_id, entity_type, entity_id, action)
         VALUES ($1, $2, 'task', $3, 'update')`,
        [ids.projectId, ids.userId, taskId],
      ),
    ).rejects.toThrow(/audit_before_after_present/);
  });

  it('audit rows outlive the entity they describe', async () => {
    const taskId = await insertTask(exec, ids, { wbs_code: `'7.0'` });
    await exec.query(
      `INSERT INTO audit_log_entry (project_id, actor_user_id, entity_type, entity_id, action, before_json)
       VALUES ($1, $2, 'task', $3, 'delete', '{"name":"Excavate"}'::jsonb)`,
      [ids.projectId, ids.userId, taskId],
    );
    await exec.query(`DELETE FROM task WHERE id = $1`, [taskId]);

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log_entry WHERE entity_id = $1`,
      [taskId],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('FR-PRJ-08: allows duplicate project names in one organization', async () => {
    await exec.query(
      `INSERT INTO project (org_id, name, start_date, calendar_id, created_by)
       VALUES ($1, 'Warehouse build', '2026-09-01T08:00:00Z', $2, $3)`,
      [ids.orgId, ids.calendarId, ids.userId],
    );
    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM project WHERE name = 'Warehouse build'`,
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(2);
  });

  it('FR-AUTH-04: the same email may exist in two organizations but not twice in one', async () => {
    const other = await exec.query<{ id: string }>(
      `INSERT INTO organization (name) VALUES ('Globex') RETURNING id`,
    );
    await exec.query(
      `INSERT INTO app_user (org_id, name, email, auth_provider)
       VALUES ($1, 'Dana Elsewhere', 'dana@acme.test', 'password')`,
      [other.rows[0]!.id],
    );
    await expect(
      exec.query(
        `INSERT INTO app_user (org_id, name, email, auth_provider)
         VALUES ($1, 'Impostor', 'DANA@acme.test', 'password')`,
        [ids.orgId],
      ),
    ).rejects.toThrow();
  });
});

describe('migration runner', () => {
  it('is idempotent — a second run applies nothing', async () => {
    const db = new PGlite();
    const exec = executorFor(db);
    const files = loadMigrationFiles(migrationsDirectory);

    const first = await applyMigrations(exec, files);
    expect(first).toEqual(files.map((file) => file.name));

    const second = await applyMigrations(exec, files);
    expect(second).toEqual([]);
  });

  it('refuses to run when an applied migration was edited', async () => {
    const db = new PGlite();
    const exec = executorFor(db);
    const files = loadMigrationFiles(migrationsDirectory);
    await applyMigrations(exec, files);

    const tampered = files.map((file) =>
      file.name === files[0]!.name ? { ...file, checksum: 'deadbeef' } : file,
    );
    await expect(applyMigrations(exec, tampered)).rejects.toBeInstanceOf(MigrationChecksumError);
  });

  it('leaves no partial schema when a migration fails midway', async () => {
    const db = new PGlite();
    const exec = executorFor(db);
    const broken = [
      {
        name: '9999_broken.sql',
        sql: 'CREATE TABLE ok_table (id int); CREATE TABLE bad_table (id nonsense_type);',
        checksum: 'abc123',
      },
    ];

    await expect(applyMigrations(exec, broken)).rejects.toThrow();

    const { rows } = await exec.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'ok_table'`,
    );
    expect(rows).toEqual([]);
  });
});
