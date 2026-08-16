import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, loadMigrationFiles, migrationsDirectory } from '@projectapp/db';
import type { SqlExecutor } from '@projectapp/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadCpmScheduleInput } from './graph.js';

/**
 * W5-1: the graph loader's two contractual properties — a bounded query count regardless of task
 * count, and cross-project isolation — proved against a real in-process Postgres, not eyeballed.
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

/** Wraps an executor to count `.query` calls, without changing behaviour. */
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

interface SeededProject {
  readonly projectId: string;
  readonly userId: string;
  readonly defaultCalendarId: string;
}

async function seedOrgAndUser(name: string, email: string): Promise<{ orgId: string; userId: string }> {
  const org = await exec.query<{ id: string }>(
    `INSERT INTO organization (name) VALUES ($1) RETURNING id`,
    [name],
  );
  const orgId = org.rows[0]!.id;
  const user = await exec.query<{ id: string }>(
    `INSERT INTO app_user (org_id, name, email, auth_provider)
     VALUES ($1, 'Dana PM', $2, 'password') RETURNING id`,
    [orgId, email],
  );
  return { orgId, userId: user.rows[0]!.id };
}

async function seedProject(
  orgId: string,
  userId: string,
  calendarName: string,
): Promise<SeededProject> {
  const calendar = await exec.query<{ id: string }>(
    `INSERT INTO calendar (project_id, name, working_days, working_hours_start_minute,
                           working_hours_end_minute, is_default)
     VALUES (NULL, $1, '{1,2,3,4,5}', 540, 1020, true) RETURNING id`,
    [calendarName],
  );
  const defaultCalendarId = calendar.rows[0]!.id;

  const project = await exec.query<{ id: string }>(
    `INSERT INTO project (org_id, name, start_date, calendar_id, created_by)
     VALUES ($1, 'Warehouse build', '2026-09-01T08:00:00Z', $2, $3) RETURNING id`,
    [orgId, defaultCalendarId, userId],
  );
  // The default calendar is scoped to the project it belongs to (matches 0001_init's pattern of
  // adding the FK after `project` exists), so back-fill it.
  await exec.query(`UPDATE calendar SET project_id = $1 WHERE id = $2`, [
    project.rows[0]!.id,
    defaultCalendarId,
  ]);

  return { projectId: project.rows[0]!.id, userId, defaultCalendarId };
}

async function insertTasks(
  projectId: string,
  userId: string,
  count: number,
  calendarId: string | null = null,
): Promise<string[]> {
  const ids: string[] = [];
  const values: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (let i = 0; i < count; i += 1) {
    values.push(
      `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
    );
    params.push(
      projectId,
      String(i + 1),
      `Task ${i + 1}`,
      8,
      '2026-09-01T08:00:00Z',
      '2026-09-01T16:00:00Z',
      userId,
    );
  }
  const { rows } = await exec.query<{ id: string }>(
    `INSERT INTO task (project_id, wbs_code, name, duration_hours, start, finish, updated_by)
     VALUES ${values.join(', ')}
     RETURNING id`,
    params,
  );
  ids.push(...rows.map((row) => row.id));

  if (calendarId !== null) {
    await exec.query(`UPDATE task SET calendar_id = $1 WHERE id = ANY($2::uuid[])`, [
      calendarId,
      ids,
    ]);
  }
  return ids;
}

describe('loadCpmScheduleInput: bounded query count', () => {
  it.each([10, 500])('issues exactly 4 queries for a project with %i tasks', async (count) => {
    const { orgId, userId } = await seedOrgAndUser('Acme', 'dana@acme.test');
    const project = await seedProject(orgId, userId, 'Mon-Fri');
    await insertTasks(project.projectId, userId, count);

    const spy = countingExecutor(exec);
    const input = await loadCpmScheduleInput(spy.exec, project.projectId);

    expect(spy.count()).toBe(4);
    expect(input.tasks).toHaveLength(count);
  });

  it('the query count does not change with a second calendar or dependencies present', async () => {
    const { orgId, userId } = await seedOrgAndUser('Acme', 'dana@acme.test');
    const project = await seedProject(orgId, userId, 'Mon-Fri');
    const nightShift = await exec.query<{ id: string }>(
      `INSERT INTO calendar (project_id, name, working_days, working_hours_start_minute,
                             working_hours_end_minute, is_default)
       VALUES ($1, 'Night Shift', '{1,2,3,4,5}', 1200, 1380, false) RETURNING id`,
      [project.projectId],
    );
    const ids = await insertTasks(project.projectId, userId, 20, nightShift.rows[0]!.id);
    for (let i = 0; i < ids.length - 1; i += 1) {
      await exec.query(
        `INSERT INTO dependency (project_id, predecessor_id, successor_id, type)
         VALUES ($1, $2, $3, 'FS')`,
        [project.projectId, ids[i], ids[i + 1]],
      );
    }

    const spy = countingExecutor(exec);
    const input = await loadCpmScheduleInput(spy.exec, project.projectId);

    expect(spy.count()).toBe(4);
    expect(input.dependencies).toHaveLength(19);
    expect(input.calendars.map((c) => c.id).sort()).toEqual(
      [project.defaultCalendarId, nightShift.rows[0]!.id].sort(),
    );
  });
});

describe('loadCpmScheduleInput: shape', () => {
  it('inlines calendar exceptions with no extra query', async () => {
    const { orgId, userId } = await seedOrgAndUser('Acme', 'dana@acme.test');
    const project = await seedProject(orgId, userId, 'Mon-Fri');
    await exec.query(
      `INSERT INTO calendar_exception (calendar_id, date, is_working)
       VALUES ($1, '2026-12-25', false)`,
      [project.defaultCalendarId],
    );
    await insertTasks(project.projectId, userId, 3);

    const input = await loadCpmScheduleInput(exec, project.projectId);
    const defaultCalendar = input.calendars.find((c) => c.id === project.defaultCalendarId)!;
    expect(defaultCalendar.exceptions).toEqual([
      { date: '2026-12-25', isWorking: false, startMinuteOverride: null, endMinuteOverride: null },
    ]);
  });

  it('reports manualStart/manualFinish only for manually-scheduled tasks', async () => {
    const { orgId, userId } = await seedOrgAndUser('Acme', 'dana@acme.test');
    const project = await seedProject(orgId, userId, 'Mon-Fri');
    const [autoId] = await insertTasks(project.projectId, userId, 1);
    await exec.query(
      `INSERT INTO task (project_id, wbs_code, name, duration_hours, start, finish, updated_by,
                          schedule_mode)
       VALUES ($1, '2', 'Manual task', 8, '2026-09-05T08:00:00Z', '2026-09-05T16:00:00Z', $2, 'manual')`,
      [project.projectId, userId],
    );

    const input = await loadCpmScheduleInput(exec, project.projectId);
    const auto = input.tasks.find((t) => t.id === autoId)!;
    const manual = input.tasks.find((t) => t.scheduleMode === 'manual')!;

    expect(auto.manualStart).toBeNull();
    expect(auto.manualFinish).toBeNull();
    expect(manual.manualStart).toBe('2026-09-05T08:00:00.000Z');
    expect(manual.manualFinish).toBe('2026-09-05T16:00:00.000Z');
  });

  it('throws not_found for a project that does not exist', async () => {
    await expect(
      loadCpmScheduleInput(exec, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('loadCpmScheduleInput: cross-project isolation (FR-AUTH-04 read-side)', () => {
  it('never returns another project\'s tasks, dependencies, or same-named calendar', async () => {
    const { orgId, userId } = await seedOrgAndUser('Acme', 'dana@acme.test');
    const projectA = await seedProject(orgId, userId, 'Mon-Fri');
    const projectB = await seedProject(orgId, userId, 'Mon-Fri'); // same calendar name, different id

    const aTaskIds = await insertTasks(projectA.projectId, userId, 5);
    const bTaskIds = await insertTasks(projectB.projectId, userId, 5);

    await exec.query(
      `INSERT INTO dependency (project_id, predecessor_id, successor_id, type)
       VALUES ($1, $2, $3, 'FS')`,
      [projectA.projectId, aTaskIds[0], aTaskIds[1]],
    );
    await exec.query(
      `INSERT INTO dependency (project_id, predecessor_id, successor_id, type)
       VALUES ($1, $2, $3, 'FS')`,
      [projectB.projectId, bTaskIds[0], bTaskIds[1]],
    );

    const input = await loadCpmScheduleInput(exec, projectA.projectId);

    expect(input.tasks.map((t) => t.id).sort()).toEqual([...aTaskIds].sort());
    expect(input.tasks.some((t) => bTaskIds.includes(t.id))).toBe(false);

    expect(input.dependencies).toHaveLength(1);
    expect(bTaskIds).not.toContain(input.dependencies[0]!.predecessorId);

    // Both projects' default calendars are literally named "Mon-Fri" but have different ids —
    // the loader must resolve project A's own id, never project B's row with the same name.
    expect(input.defaultCalendarId).toBe(projectA.defaultCalendarId);
    expect(input.calendars.map((c) => c.id)).toEqual([projectA.defaultCalendarId]);
    expect(input.calendars.map((c) => c.id)).not.toContain(projectB.defaultCalendarId);
  });

  it('a task calendar override naming another project\'s calendar id is simply absent, not resolved', async () => {
    // Constructs the scenario the write path (`requireProjectCalendar`) is supposed to prevent
    // from ever being written, and proves the read path does not quietly paper over it by
    // resolving a foreign calendar id if one somehow ended up on a row.
    const { orgId, userId } = await seedOrgAndUser('Acme', 'dana@acme.test');
    const projectA = await seedProject(orgId, userId, 'Mon-Fri');
    const projectB = await seedProject(orgId, userId, 'Other Cal');

    const [taskId] = await insertTasks(projectA.projectId, userId, 1);
    // Bypasses the API layer on purpose — this is a database-level check, not a route check.
    await exec.query(`UPDATE task SET calendar_id = $1 WHERE id = $2`, [
      projectB.defaultCalendarId,
      taskId,
    ]);

    const input = await loadCpmScheduleInput(exec, projectA.projectId);
    const task = input.tasks.find((t) => t.id === taskId)!;
    expect(task.calendarId).toBe(projectB.defaultCalendarId);
    // The dangling reference is surfaced as a `missing_calendar` diagnostic by the engine (it is
    // not in `input.calendars`), never silently resolved by the loader reaching cross-project.
    expect(input.calendars.map((c) => c.id)).not.toContain(projectB.defaultCalendarId);
  });
});
