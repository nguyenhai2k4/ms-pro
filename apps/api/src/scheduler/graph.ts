import type { SqlExecutor } from '@projectapp/db';
import type {
  CpmCalendar,
  CpmDependency,
  CpmScheduleInput,
  CpmTask,
} from '@projectapp/shared-types';
import { cpmScheduleInputSchema } from '@projectapp/shared-types';
import { notFound } from '../errors.js';

/**
 * Assembles `CpmScheduleInput` — everything `packages/cpm-engine` needs for one project — in a
 * **bounded number of queries regardless of task count** (W5-1, ADR-010 point 6).
 *
 * ## Why this exists
 *
 * `apps/api/src/scheduler/rollup.ts`'s `recomputeChain` does 2 queries per ancestor level, which
 * is exactly the pattern P1's QA review flagged as unable to hold FR-SCH-06's budget once a full
 * CPM pass runs over up to 5,000 tasks (`docs/IMPLEMENTATION-PLAN.md` risk register). This module
 * is the fix: every load below is a single `WHERE project_id = $1` / `WHERE id = ANY($1)` set
 * query, never a query per row or per tree level.
 *
 * ## The four queries, in order
 *
 *  1. The project row — its fixed start date and its default calendar id.
 *  2. Every task in the project (all columns the engine's `CpmTask` needs).
 *  3. Every dependency in the project.
 *  4. Every calendar *referenced* by (1) or (2) — the project's default plus each task's own
 *     override — with its exceptions inlined via a `LEFT JOIN ... json_agg`, so exceptions never
 *     cost a fifth query or a query per calendar.
 *
 * Query (4) depends on the calendar ids gathered from (1) and (2), so it cannot be issued until
 * those return; the four queries are therefore sequential, not "at most 4 in parallel". The count
 * is still exactly 4 whether the project has 10 tasks or 5,000 — nothing here scales with row
 * count except the width of the `= ANY($1)` array, which costs nothing extra as a query.
 *
 * ## Cross-project isolation
 *
 * Task and dependency rows are scoped by `WHERE project_id = $1` directly, so a same-named task
 * or dependency in another project is never selected in the first place. Calendars are one step
 * indirect — resolved by an id gathered off of already-scoped rows, not by a `project_id` column
 * of their own on the query — so the calendar query carries an explicit
 * `(c.project_id = $projectId OR c.project_id IS NULL)` predicate on top of the id list. The
 * `OR IS NULL` half is FR-CAL-04's org-level template calendars, legitimately shared across
 * projects; the `= $projectId` half is what stops a same-named (or, worse, a bugged/bypassed)
 * foreign calendar id from ever being resolved just because it showed up in the id set. Without
 * that predicate this loader would be exactly the "existence oracle" bug class P1's QA review
 * found twice in the calendar and task routes, just moved from a write path to a read one — see
 * `graph.test.ts`'s isolation suite, which fails without this predicate.
 *
 * ## Direction
 *
 * `CpmScheduleDirection` is a one-member enum (`'forward'`) for this roadmap phase (FR-SCH-09 is
 * P2-the-product-phase, not P2-the-roadmap-phase — see `cpm.ts`'s header). `project` has no
 * `direction` column to read, so this loader supplies the literal. When backward scheduling lands,
 * `project` gains the column and this line changes with it; it is not a workaround, it is the
 * whole of what the current contract asks for.
 *
 * The returned value is parsed through `cpmScheduleInputSchema` — the same "validate at the
 * boundary, don't hand-assemble a trusted shape" pattern `apps/api/src/routes/tasks.ts` uses for
 * `buildEnvelope`. It also brands every id, so nothing downstream can mix a `TaskId` and a
 * `CalendarId` by accident.
 */

interface ProjectRow {
  start_date: Date | string;
  calendar_id: string;
}

interface GraphTaskRow {
  id: string;
  parent_id: string | null;
  duration_hours: number;
  start: Date | string;
  finish: Date | string;
  is_milestone: boolean;
  schedule_mode: CpmTask['scheduleMode'];
  constraint_type: CpmTask['constraintType'];
  constraint_date: Date | string | null;
  calendar_id: string | null;
}

interface GraphDependencyRow {
  id: string;
  predecessor_id: string;
  successor_id: string;
  type: CpmDependency['type'];
  lag_hours: number;
}

interface GraphCalendarExceptionJson {
  date: string;
  is_working: boolean;
  start_override: number | null;
  end_override: number | null;
}

interface GraphCalendarRow {
  id: string;
  working_days: number[];
  working_hours_start_minute: number;
  working_hours_end_minute: number;
  exceptions: GraphCalendarExceptionJson[];
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

function toCpmTask(row: GraphTaskRow): CpmTask {
  const isManual = row.schedule_mode === 'manual';
  return {
    id: row.id as CpmTask['id'],
    parentId: row.parent_id as CpmTask['parentId'],
    durationHours: Number(row.duration_hours),
    isMilestone: row.is_milestone,
    scheduleMode: row.schedule_mode,
    constraintType: row.constraint_type,
    constraintDate: isoOrNull(row.constraint_date) as CpmTask['constraintDate'],
    calendarId: row.calendar_id as CpmTask['calendarId'],
    // FR-TSK-05: a manual task's fixed dates are exactly what is stored on the row; an auto task
    // carries no manual dates at all, so a stale value from a previous manual stint can never leak
    // into a computation it should not influence (`cpm.ts`'s own warning, restated at the source).
    manualStart: isManual ? (iso(row.start) as CpmTask['manualStart']) : null,
    manualFinish: isManual ? (iso(row.finish) as CpmTask['manualFinish']) : null,
  };
}

function toCpmDependency(row: GraphDependencyRow): CpmDependency {
  return {
    id: row.id as CpmDependency['id'],
    predecessorId: row.predecessor_id as CpmDependency['predecessorId'],
    successorId: row.successor_id as CpmDependency['successorId'],
    type: row.type,
    lagHours: Number(row.lag_hours),
  };
}

function toCpmCalendar(row: GraphCalendarRow): CpmCalendar {
  return {
    id: row.id as CpmCalendar['id'],
    workingDays: row.working_days,
    workingHoursStartMinute: row.working_hours_start_minute,
    workingHoursEndMinute: row.working_hours_end_minute,
    exceptions: row.exceptions.map((exception) => ({
      // Postgres's own JSON serialisation of a `date` column is already `YYYY-MM-DD` — no
      // `Date` round trip and no timezone reading involved (ADR-011).
      date: exception.date as CpmCalendar['exceptions'][number]['date'],
      isWorking: exception.is_working,
      startMinuteOverride: exception.start_override,
      endMinuteOverride: exception.end_override,
    })),
  };
}

/**
 * Loads the complete CPM input graph for one project. Throws `not_found` if the project itself
 * does not exist (FR-AUTH-04: the caller is expected to have already established project access —
 * this function does not re-check RBAC, matching every other loader in this codebase).
 */
export async function loadCpmScheduleInput(
  exec: SqlExecutor,
  projectId: string,
): Promise<CpmScheduleInput> {
  // Query 1: the project's own fixed start and default calendar.
  const { rows: projectRows } = await exec.query<ProjectRow>(
    `SELECT start_date, calendar_id FROM project WHERE id = $1`,
    [projectId],
  );
  const project = projectRows[0];
  if (project === undefined) throw notFound('Project not found');

  // Query 2: every task in the project — set-based, not per ancestor level.
  const { rows: taskRows } = await exec.query<GraphTaskRow>(
    `SELECT id, parent_id, duration_hours, start, finish, is_milestone, schedule_mode,
            constraint_type, constraint_date, calendar_id
       FROM task
      WHERE project_id = $1`,
    [projectId],
  );

  // Query 3: every dependency in the project.
  const { rows: dependencyRows } = await exec.query<GraphDependencyRow>(
    `SELECT id, predecessor_id, successor_id, type, lag_hours
       FROM dependency
      WHERE project_id = $1`,
    [projectId],
  );

  // Query 4: every calendar referenced by the project default or any task, exceptions inlined.
  // The id set is gathered from rows already scoped to this project (queries 1 and 2), but a
  // `calendar_id` column has no FK-level project scoping of its own, so the query below also
  // filters explicitly on `project_id` — see the "Cross-project isolation" note above.
  const referencedCalendarIds = [
    ...new Set(
      [project.calendar_id, ...taskRows.map((row) => row.calendar_id)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];

  const { rows: calendarRows } = await exec.query<GraphCalendarRow>(
    `SELECT c.id, c.working_days, c.working_hours_start_minute, c.working_hours_end_minute,
            COALESCE(
              json_agg(
                json_build_object(
                  'date', ce.date,
                  'is_working', ce.is_working,
                  'start_override', ce.working_hours_start_minute_override,
                  'end_override', ce.working_hours_end_minute_override
                )
              ) FILTER (WHERE ce.id IS NOT NULL),
              '[]'
            ) AS exceptions
       FROM calendar c
       LEFT JOIN calendar_exception ce ON ce.calendar_id = c.id
      WHERE c.id = ANY($1::uuid[])
        AND (c.project_id = $2 OR c.project_id IS NULL)
      GROUP BY c.id`,
    [referencedCalendarIds, projectId],
  );

  const input: CpmScheduleInput = {
    projectId: projectId as CpmScheduleInput['projectId'],
    projectStart: iso(project.start_date) as CpmScheduleInput['projectStart'],
    direction: 'forward',
    defaultCalendarId: project.calendar_id as CpmScheduleInput['defaultCalendarId'],
    calendars: calendarRows.map(toCpmCalendar),
    tasks: taskRows.map(toCpmTask),
    dependencies: dependencyRows.map(toCpmDependency),
  };

  return cpmScheduleInputSchema.parse(input);
}
