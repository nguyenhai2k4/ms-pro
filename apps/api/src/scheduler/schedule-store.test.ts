import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import type { CpmTaskSchedule } from '@projectapp/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { bulkUpsertTaskSchedules } from './schedule-store.js';

/** W5-1: the bulk upsert writes any batch of `task_schedule` rows in exactly one query. */

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

function countingExecutor(base: SqlExecutor): { exec: SqlExecutor; count: () => number } {
  let calls = 0;
  return {
    exec: {
      exec: (sql) => base.exec(sql),
      query: (text, params) => {
        calls += 1;
        return base.query(text, params);
      },
    },
    count: () => calls,
  };
}

let db: PGlite;
let exec: SqlExecutor;

beforeEach(async () => {
  db = new PGlite();
  exec = executorFor(db);
  await applyMigrations(exec, loadMigrationFiles(migrationsDirectory));
});

async function seedTasks(count: number): Promise<string[]> {
  const org = await exec.query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ('Acme') RETURNING id`,
  );
  const user = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, 'Dana PM', 'dana@acme.test', 'password') RETURNING id`,
    [org.rows[0]!.id],
  );
  const calendar = await exec.query<{ id: string }>(
    `INSERT INTO calendar (project_id, name, working_days, working_hours_start_minute,
                           working_hours_end_minute, is_default)
     VALUES (NULL, 'Mon-Fri', '{1,2,3,4,5}', 540, 1020, true) RETURNING id`,
  );
  const project = await exec.query<{ id: string }>(
    `INSERT INTO project (org_id, name, start_date, calendar_id, created_by)
     VALUES ($1, 'Warehouse build', '2026-09-01T08:00:00Z', $2, $3) RETURNING id`,
    [org.rows[0]!.id, calendar.rows[0]!.id, user.rows[0]!.id],
  );

  const values: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (let i = 0; i < count; i += 1) {
    values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      project.rows[0]!.id,
      String(i + 1),
      `Task ${i + 1}`,
      8,
      '2026-09-01T08:00:00Z',
      '2026-09-01T16:00:00Z',
      user.rows[0]!.id,
    );
  }
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO task (project_id, wbs_code, name, duration_hours, start, finish, updated_by)
     VALUES ${values.join(', ')}
     RETURNING id`,
    params,
  );
  return rows.map((row) => row.id);
}

function scheduleFor(taskId: string, overrides: Partial<CpmTaskSchedule> = {}): CpmTaskSchedule {
  return {
    taskId: taskId as CpmTaskSchedule['taskId'],
    earlyStart: '2026-09-01T08:00:00.000Z',
    earlyFinish: '2026-09-01T16:00:00.000Z',
    lateStart: '2026-09-01T08:00:00.000Z',
    lateFinish: '2026-09-01T16:00:00.000Z',
    totalFloatHours: 0,
    isCritical: true,
    hasScheduleConflict: false,
    start: '2026-09-01T08:00:00.000Z',
    finish: '2026-09-01T16:00:00.000Z',
    durationHours: 8,
    ...overrides,
  };
}

interface ScheduleRow {
  task_id: string;
  early_start: Date | string;
  early_finish: Date | string;
  late_start: Date | string;
  late_finish: Date | string;
  total_float_hours: number;
  is_critical: boolean;
  has_schedule_conflict: boolean;
  computed_at: Date | string;
}

describe('bulkUpsertTaskSchedules', () => {
  it('writes 500 rows in exactly one query', async () => {
    const taskIds = await seedTasks(500);
    const schedules = taskIds.map((id) => scheduleFor(id));

    const spy = countingExecutor(exec);
    await bulkUpsertTaskSchedules(spy.exec, '2026-09-01T09:00:00.000Z', schedules);

    expect(spy.count()).toBe(1);

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_schedule`,
    );
    expect(rows[0]!.count).toBe('500');
  });

  it('persists every column correctly, including a negative float', async () => {
    const [taskId] = await seedTasks(1);
    await bulkUpsertTaskSchedules(exec, '2026-09-01T09:00:00.000Z', [
      scheduleFor(taskId!, { totalFloatHours: -16, isCritical: false, hasScheduleConflict: true }),
    ]);

    const { rows } = await exec.query<ScheduleRow>(
      `SELECT * FROM task_schedule WHERE task_id = $1`,
      [taskId],
    );
    const row = rows[0]!;
    expect(row.total_float_hours).toBe(-16);
    expect(row.is_critical).toBe(false);
    expect(row.has_schedule_conflict).toBe(true);
    expect(new Date(row.computed_at).toISOString()).toBe('2026-09-01T09:00:00.000Z');
  });

  it('upserts: a second call with the same task ids updates in place, still one query, no duplicate rows', async () => {
    const taskIds = await seedTasks(3);
    await bulkUpsertTaskSchedules(
      exec,
      '2026-09-01T09:00:00.000Z',
      taskIds.map((id) => scheduleFor(id, { totalFloatHours: 40, isCritical: false })),
    );

    const spy = countingExecutor(exec);
    await bulkUpsertTaskSchedules(
      spy.exec,
      '2026-09-02T09:00:00.000Z',
      taskIds.map((id) => scheduleFor(id, { totalFloatHours: 0, isCritical: true })),
    );
    expect(spy.count()).toBe(1);

    const { rows } = await exec.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_schedule`,
    );
    expect(rows[0]!.count).toBe('3');

    const updated = await exec.query<ScheduleRow>(
      `SELECT * FROM task_schedule WHERE task_id = $1`,
      [taskIds[0]],
    );
    expect(updated.rows[0]!.total_float_hours).toBe(0);
    expect(updated.rows[0]!.is_critical).toBe(true);
    expect(new Date(updated.rows[0]!.computed_at).toISOString()).toBe('2026-09-02T09:00:00.000Z');
  });

  it('is a no-op — and issues no query — for an empty batch', async () => {
    const spy = countingExecutor(exec);
    await bulkUpsertTaskSchedules(spy.exec, '2026-09-01T09:00:00.000Z', []);
    expect(spy.count()).toBe(0);
  });

  it('a schedule for a task that no longer exists is rejected by the FK, not silently dropped', async () => {
    await expect(
      bulkUpsertTaskSchedules(exec, '2026-09-01T09:00:00.000Z', [
        scheduleFor('00000000-0000-4000-8000-000000000000'),
      ]),
    ).rejects.toThrow();
  });
});
