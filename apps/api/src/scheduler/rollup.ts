import { randomUUID } from 'node:crypto';
import type { SqlExecutor } from '@projectapp/db';
import { taskInvariantsSchema } from '@projectapp/shared-types';
import type {
  ConstraintType,
  MutationIntentEnvelope,
  ScheduleMode,
  TaskStatus,
} from '@projectapp/shared-types';
import { conflict, notFound, validationFailed } from '../errors.js';

/**
 * The P1 in-process scheduler (ADR-007).
 *
 * ## What this is
 *
 * `apps/api` must never write `task.start` / `task.finish` / the rollup-derived columns from its
 * own arithmetic (CLAUDE.md invariant 2). Route handlers therefore validate a request, turn it
 * into a `TaskIntent` and hand the envelope to `applyTaskIntent` — the single function in this
 * repo allowed to write those columns. In P2 the same envelope crosses a process boundary to the
 * standalone Scheduler Service and callers do not change; in P3 the ADR-002 single-writer queue
 * slots in front of this entry point, which is why it stays *one* function taking *one* envelope
 * rather than a set of exported mutators. ADR-007's open question — whether P1 needs that queue —
 * is answered "no" in `packages/shared-types/src/intents.ts`: one writer per HTTP request, no
 * realtime clients yet, and a Postgres transaction already serialises conflicting row writes.
 *
 * ## What this is emphatically NOT
 *
 * It is **not** a preview of `packages/cpm-engine`. There is no dependency graph, no constraint
 * enforcement, no forward/backward pass, no float, and no calendar-aware date arithmetic. Those
 * are FR-SCH-01..09 and belong to P2. The two places that boundary shows:
 *
 *  - a leaf's `finish` is `start + durationHours` of **wall-clock** time, not working time;
 *  - a parent's `durationHours` is the raw wall-clock span of its children, not the working-hours
 *    duration a calendar would produce (FR-SCH-07).
 *
 * Both are deliberate P1 scope boundaries, not oversights. When the CPM engine lands it owns these
 * numbers and this module's date arithmetic goes away.
 *
 * ## Rollup rule (FR-TSK-03, FR-TRK-04)
 *
 * For a task with children: `start = min(children.start)`, `finish = max(children.finish)`,
 * `durationHours = span(start, finish)`, `pctComplete = duration-weighted mean of children`.
 * Every child contributes regardless of `scheduleMode` — FR-TSK-05 says a manually scheduled task
 * is excluded from auto-shift but "still contributes to parent rollup". A task with no children is
 * a leaf and its fields are exactly what was written to it, never rollup-derived. Recomputation
 * walks the **entire** ancestor chain, so a leaf edit three levels down reaches the grandparent.
 *
 * ## Errors
 *
 * This module throws `ApiException`s directly. That is a deliberate P1 simplification: it lives
 * inside `apps/api` and its only caller is a route handler, so an intermediate error taxonomy
 * would be mapped straight back onto these codes. When the module moves out of process in P2 the
 * errors become transport-neutral scheduler failures and the mapping moves to the client.
 */

// ----------------------------------------------------------------------------------------------
// Row shape and mapping. `packages/db` owns snake_case; everything above this line is camelCase.
// ----------------------------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  wbs_code: string;
  name: string;
  duration_hours: number;
  start: Date | string;
  finish: Date | string;
  pct_complete: number;
  is_milestone: boolean;
  schedule_mode: ScheduleMode;
  constraint_type: ConstraintType;
  constraint_date: Date | string | null;
  calendar_id: string | null;
  priority: number;
  status: TaskStatus;
  actual_start: Date | string | null;
  actual_finish: Date | string | null;
  notes: string;
  created_at: Date | string;
  updated_at: Date | string;
  updated_by: string;
}

const TASK_COLUMNS = [
  'id',
  'project_id',
  'parent_id',
  'wbs_code',
  'name',
  'duration_hours',
  'start',
  'finish',
  'pct_complete',
  'is_milestone',
  'schedule_mode',
  'constraint_type',
  'constraint_date',
  'calendar_id',
  'priority',
  'status',
  'actual_start',
  'actual_finish',
  'notes',
  'created_at',
  'updated_at',
  'updated_by',
] as const;

export const TASK_SELECT = TASK_COLUMNS.join(', ');
const TASK_SELECT_T = TASK_COLUMNS.map((column) => `t.${column}`).join(', ');

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const isoOrNull = (value: Date | string | null): string | null =>
  value === null ? null : iso(value);

/** Row -> the `Task` shape in `packages/shared-types/src/entities.ts`. */
export function toTask(row: TaskRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    wbsCode: row.wbs_code,
    name: row.name,
    durationHours: Number(row.duration_hours),
    start: iso(row.start),
    finish: iso(row.finish),
    pctComplete: Number(row.pct_complete),
    isMilestone: row.is_milestone,
    scheduleMode: row.schedule_mode,
    constraintType: row.constraint_type,
    constraintDate: isoOrNull(row.constraint_date),
    calendarId: row.calendar_id,
    priority: Number(row.priority),
    status: row.status,
    actualStart: isoOrNull(row.actual_start),
    actualFinish: isoOrNull(row.actual_finish),
    notes: row.notes,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    updatedBy: row.updated_by,
  };
}

export type TaskDto = ReturnType<typeof toTask>;

// ----------------------------------------------------------------------------------------------
// The rollup itself — pure, so it can be tested without a database (FR-TSK-03, FR-TRK-04).
// ----------------------------------------------------------------------------------------------

export interface RollupChild {
  readonly start: string;
  readonly finish: string;
  readonly durationHours: number;
  readonly pctComplete: number;
}

export interface RollupValues {
  readonly start: string;
  readonly finish: string;
  readonly durationHours: number;
  readonly pctComplete: number;
}

const MS_PER_HOUR = 3_600_000;

/**
 * FR-TSK-03. `children` must be non-empty — a task with no children is a leaf and is never rolled
 * up. FR-TRK-04's duration weighting collapses to a plain mean when every child has zero duration
 * (a parent whose children are all milestones); weighting by zero would otherwise divide by zero
 * and produce `NaN`, which the `pct_complete BETWEEN 0 AND 100` check would then reject as a 500.
 *
 * FR-TRK-04 also allows a *manual override* of a parent's rolled-up % complete. That is not
 * implemented: it needs a persisted "override" flag on `task` that the P0 schema does not have,
 * and inventing a column here would be a migration written ahead of its requirement. FR-TRK-04 is
 * therefore partially implemented in P1 — duration-weighted rollup yes, manual override no.
 */
export function rollupFromChildren(children: readonly RollupChild[]): RollupValues {
  if (children.length === 0) {
    throw new Error('rollupFromChildren requires at least one child');
  }

  let startMs = Number.POSITIVE_INFINITY;
  let finishMs = Number.NEGATIVE_INFINITY;
  let weightedPct = 0;
  let totalWeight = 0;
  let plainPct = 0;

  for (const child of children) {
    startMs = Math.min(startMs, Date.parse(child.start));
    finishMs = Math.max(finishMs, Date.parse(child.finish));
    weightedPct += child.pctComplete * child.durationHours;
    totalWeight += child.durationHours;
    plainPct += child.pctComplete;
  }

  const pct = totalWeight > 0 ? weightedPct / totalWeight : plainPct / children.length;

  return {
    start: new Date(startMs).toISOString(),
    finish: new Date(finishMs).toISOString(),
    durationHours: (finishMs - startMs) / MS_PER_HOUR,
    pctComplete: Math.min(100, Math.max(0, pct)),
  };
}

// ----------------------------------------------------------------------------------------------
// What a mutation changed. The route turns this straight into audit rows, which is how invariant 4
// covers rollup side effects: a grandparent whose dates moved because of a leaf edit is itself a
// schedule-affecting change and appears here with its own before/after.
// ----------------------------------------------------------------------------------------------

export interface TaskChange {
  /** Null when the task was created by this mutation. */
  readonly before: TaskDto | null;
  /** Null when the task was deleted by this mutation. */
  readonly after: TaskDto | null;
}

export interface ApplyTaskIntentResult {
  /** The directly addressed task after the mutation; null for a delete. */
  readonly task: TaskDto | null;
  /**
   * Every task row this mutation created, changed or removed, in the order it happened: the
   * addressed task, every ancestor whose rollup moved, every task renumbered by a WBS change, and
   * every row removed by a cascade delete.
   */
  readonly changes: readonly TaskChange[];
}

class ChangeSet {
  private readonly entries = new Map<string, { before: TaskDto | null; after: TaskDto | null }>();

  /** The first `before` seen for a row wins — later touches only move the `after`. */
  record(id: string, before: TaskDto | null, after: TaskDto | null): void {
    const existing = this.entries.get(id);
    this.entries.set(id, { before: existing?.before ?? before, after });
  }

  list(): TaskChange[] {
    return [...this.entries.values()];
  }
}

// ----------------------------------------------------------------------------------------------
// Loads
// ----------------------------------------------------------------------------------------------

async function loadTask(
  exec: SqlExecutor,
  projectId: string,
  taskId: string,
): Promise<TaskRow | null> {
  const { rows } = await exec.query<TaskRow>(
    `SELECT ${TASK_SELECT} FROM task WHERE id = $1 AND project_id = $2`,
    [taskId, projectId],
  );
  return rows[0] ?? null;
}

async function requireTask(exec: SqlExecutor, projectId: string, taskId: string): Promise<TaskRow> {
  const row = await loadTask(exec, projectId, taskId);
  if (row === null) throw notFound('Task not found');
  return row;
}

/** The last dot-separated segment of a WBS code — a task's ordinal among its siblings. */
function ordinalOf(wbsCode: string): number {
  const parsed = Number.parseInt(wbsCode.slice(wbsCode.lastIndexOf('.') + 1), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Direct children in sibling order. Ordered in TypeScript rather than SQL because `wbs_code` is
 * text: `'10' < '2'` lexicographically, which would silently reorder any parent with ten children.
 */
async function loadChildren(
  exec: SqlExecutor,
  projectId: string,
  parentId: string | null,
): Promise<TaskRow[]> {
  const { rows } =
    parentId === null
      ? await exec.query<TaskRow>(
          `SELECT ${TASK_SELECT} FROM task WHERE project_id = $1 AND parent_id IS NULL`,
          [projectId],
        )
      : await exec.query<TaskRow>(
          `SELECT ${TASK_SELECT} FROM task WHERE project_id = $1 AND parent_id = $2`,
          [projectId, parentId],
        );
  return rows.sort(
    (a, b) => ordinalOf(a.wbs_code) - ordinalOf(b.wbs_code) || (a.id < b.id ? -1 : 1),
  );
}

/** A task and everything below it, deepest first — the order a `ON DELETE RESTRICT` FK allows. */
async function loadSubtreeDeepestFirst(
  exec: SqlExecutor,
  projectId: string,
  rootId: string,
): Promise<TaskRow[]> {
  const { rows } = await exec.query<TaskRow & { depth: number }>(
    `WITH RECURSIVE subtree AS (
       SELECT ${TASK_SELECT}, 0 AS depth
         FROM task WHERE id = $1 AND project_id = $2
       UNION ALL
       SELECT ${TASK_SELECT_T}, s.depth + 1
         FROM task t JOIN subtree s ON t.parent_id = s.id
     )
     SELECT * FROM subtree ORDER BY depth DESC`,
    [rootId, projectId],
  );
  return rows;
}

/** True when `candidateId` is `taskId` itself or anywhere below it (FR-TSK-02 cycle rejection). */
async function isSelfOrDescendant(
  exec: SqlExecutor,
  projectId: string,
  taskId: string,
  candidateId: string,
): Promise<boolean> {
  const subtree = await loadSubtreeDeepestFirst(exec, projectId, taskId);
  return subtree.some((row) => row.id === candidateId);
}

// ----------------------------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------------------------

/**
 * Consistency rules the row must satisfy, checked before the write so they surface as 422 rather
 * than as a database error rendered 500. `taskInvariantsSchema` is the contract's own check
 * (FR-TSK-04 milestone duration, FR-TSK-06 constraint dates) — it is applied, not reimplemented.
 * The one rule it does not express is the other half of the database's
 * `task_constraint_date_required`: ASAP/ALAP must not *carry* a date.
 */
function validateCandidate(candidate: TaskDto): void {
  const parsed = taskInvariantsSchema.safeParse(candidate);
  if (!parsed.success) throw validationFailed(parsed.error.flatten());
  if (
    (candidate.constraintType === 'ASAP' || candidate.constraintType === 'ALAP') &&
    candidate.constraintDate !== null
  ) {
    throw validationFailed(
      { fieldErrors: { constraintDate: [`FR-TSK-06: ${candidate.constraintType} takes no date`] } },
      'Request failed validation',
    );
  }
}

const ROLLUP_UPDATE = `UPDATE task
    SET start = $2, finish = $3, duration_hours = $4, pct_complete = $5,
        updated_at = $6, updated_by = $7
  WHERE id = $1
  RETURNING ${TASK_SELECT}`;

/**
 * FR-TSK-03. Recomputes `fromTaskId` (if it has children) and then every ancestor above it, all
 * the way to the top-level task. The whole chain is walked rather than stopping at the first
 * unchanged parent: the early exit is sound but it is one refactor away from being wrong, and the
 * chain is a handful of rows.
 */
async function recomputeChain(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
  fromTaskId: string | null,
  changes: ChangeSet,
): Promise<void> {
  const projectId = envelope.projectId;
  let cursor = fromTaskId;

  while (cursor !== null) {
    const node = await loadTask(exec, projectId, cursor);
    if (node === null) return;

    const children = await loadChildren(exec, projectId, node.id);
    if (children.length > 0) {
      const rolled = rollupFromChildren(children.map(toTask));
      const current = toTask(node);
      const differs =
        current.start !== rolled.start ||
        current.finish !== rolled.finish ||
        current.durationHours !== rolled.durationHours ||
        current.pctComplete !== rolled.pctComplete;

      if (differs) {
        const { rows } = await exec.query<TaskRow>(ROLLUP_UPDATE, [
          node.id,
          rolled.start,
          rolled.finish,
          rolled.durationHours,
          rolled.pctComplete,
          envelope.issuedAt,
          envelope.actorUserId,
        ]);
        changes.record(node.id, current, toTask(rows[0]!));
      }
    }

    cursor = node.parent_id;
  }
}

/**
 * FR-TSK-02. Renumbers `orderedChildIds` as children 1..n of `parent` (or of the project root when
 * `parent` is null) and recursively renumbers their subtrees.
 *
 * Two passes, because `UNIQUE (project_id, wbs_code)` is not deferrable: moving `1.2` to `1.3`
 * while `1.3` still exists would collide mid-statement. Every affected row is first parked on a
 * throwaway code that no real WBS code can equal, then given its final one.
 */
async function renumberChildren(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
  parent: TaskRow | null,
  orderedChildIds: readonly string[],
  changes: ChangeSet,
): Promise<void> {
  const projectId = envelope.projectId;
  const desired = new Map<string, string>();
  const rowsById = new Map<string, TaskRow>();

  const walk = async (prefix: string, ids: readonly string[]): Promise<void> => {
    let index = 1;
    for (const id of ids) {
      const row = await requireTask(exec, projectId, id);
      const code = prefix === '' ? String(index) : `${prefix}.${index}`;
      desired.set(id, code);
      rowsById.set(id, row);
      const grandchildren = await loadChildren(exec, projectId, id);
      await walk(
        code,
        grandchildren.map((child) => child.id),
      );
      index += 1;
    }
  };

  await walk(parent === null ? '' : parent.wbs_code, orderedChildIds);

  const pending = [...desired].filter(([id, code]) => rowsById.get(id)!.wbs_code !== code);
  if (pending.length === 0) return;

  const parking = randomUUID();
  for (const [id] of pending) {
    await exec.query(`UPDATE task SET wbs_code = $2 WHERE id = $1`, [id, `~${parking}~${id}`]);
  }
  for (const [id, code] of pending) {
    const { rows } = await exec.query<TaskRow>(
      `UPDATE task SET wbs_code = $2, updated_at = $3, updated_by = $4
        WHERE id = $1 RETURNING ${TASK_SELECT}`,
      [id, code, envelope.issuedAt, envelope.actorUserId],
    );
    changes.record(id, toTask(rowsById.get(id)!), toTask(rows[0]!));
  }
}

/** FR-TSK-01: the next free ordinal among a parent's children, gaps included. */
async function nextWbsCode(
  exec: SqlExecutor,
  projectId: string,
  parent: TaskRow | null,
): Promise<string> {
  const siblings = await loadChildren(exec, projectId, parent?.id ?? null);
  const next = siblings.reduce((max, row) => Math.max(max, ordinalOf(row.wbs_code)), 0) + 1;
  return parent === null ? String(next) : `${parent.wbs_code}.${next}`;
}

/**
 * FR-TSK-04: a milestone is a zero-duration point in time, so it cannot become a summary task —
 * its rolled-up duration would immediately violate `task_milestone_zero_duration`. Rejected here
 * with a 422 rather than left to surface as a database error.
 */
function assertNotMilestoneParent(parent: TaskRow | null): void {
  if (parent !== null && parent.is_milestone) {
    throw validationFailed(
      { formErrors: ['FR-TSK-04: a milestone cannot have children'] },
      'A milestone cannot be a summary task',
    );
  }
}

// ----------------------------------------------------------------------------------------------
// Intent handlers
// ----------------------------------------------------------------------------------------------

const MS = (hours: number): number => hours * MS_PER_HOUR;

async function applyCreate(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
  changes: ChangeSet,
): Promise<TaskDto> {
  const intent = envelope.intent;
  if (intent.kind !== 'createTask') throw new Error('unreachable');
  const projectId = envelope.projectId;

  const parent =
    intent.parentId === null ? null : await requireTask(exec, projectId, intent.parentId);
  assertNotMilestoneParent(parent);

  const { rows: projectRows } = await exec.query<{ start_date: Date | string }>(
    `SELECT start_date FROM project WHERE id = $1`,
    [projectId],
  );
  const projectStart = projectRows[0];
  if (projectStart === undefined) throw notFound('Project not found');

  // FR-SCH-09: the MVP schedules forward from the project start date. A task created without an
  // explicit start therefore begins there; once the CPM engine lands (P2) the intent's `start` is
  // advisory for manual tasks only and everything else is derived from the dependency graph.
  const start = intent.start ?? iso(projectStart.start_date);
  const finish = new Date(Date.parse(start) + MS(intent.durationHours)).toISOString();

  const candidate: TaskDto = {
    id: randomUUID(),
    projectId,
    parentId: intent.parentId,
    wbsCode: await nextWbsCode(exec, projectId, parent),
    name: intent.name,
    durationHours: intent.durationHours,
    start,
    finish,
    pctComplete: 0,
    isMilestone: intent.isMilestone,
    scheduleMode: intent.scheduleMode,
    constraintType: intent.constraintType,
    constraintDate: intent.constraintDate,
    calendarId: intent.calendarId,
    priority: intent.priority,
    status: 'not_started',
    actualStart: null,
    actualFinish: null,
    notes: '',
    createdAt: envelope.issuedAt,
    updatedAt: envelope.issuedAt,
    updatedBy: envelope.actorUserId,
  };
  validateCandidate(candidate);

  const { rows } = await exec.query<TaskRow>(
    `INSERT INTO task (id, project_id, parent_id, wbs_code, name, duration_hours, start, finish,
                       pct_complete, is_milestone, schedule_mode, constraint_type, constraint_date,
                       calendar_id, priority, status, actual_start, actual_finish, notes,
                       created_at, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
             $20, $21, $22)
     RETURNING ${TASK_SELECT}`,
    [
      candidate.id,
      candidate.projectId,
      candidate.parentId,
      candidate.wbsCode,
      candidate.name,
      candidate.durationHours,
      candidate.start,
      candidate.finish,
      candidate.pctComplete,
      candidate.isMilestone,
      candidate.scheduleMode,
      candidate.constraintType,
      candidate.constraintDate,
      candidate.calendarId,
      candidate.priority,
      candidate.status,
      candidate.actualStart,
      candidate.actualFinish,
      candidate.notes,
      candidate.createdAt,
      candidate.updatedAt,
      candidate.updatedBy,
    ],
  );
  const created = toTask(rows[0]!);
  changes.record(created.id, null, created);

  await recomputeChain(exec, envelope, created.parentId, changes);
  return created;
}

async function applyUpdate(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
  changes: ChangeSet,
): Promise<TaskDto> {
  const intent = envelope.intent;
  if (intent.kind !== 'updateTask') throw new Error('unreachable');
  const projectId = envelope.projectId;

  const row = await requireTask(exec, projectId, intent.taskId);
  const before = toTask(row);
  const children = await loadChildren(exec, projectId, row.id);
  const has = (field: string): boolean => Object.prototype.hasOwnProperty.call(intent, field);

  // FR-TSK-03 / FR-TRK-04: a summary task's start/finish/duration/% complete are all derived from
  // its children, so a direct edit to any of them would be overwritten by `recomputeChain` before
  // this same request's response is built. The overwrite is not a data-integrity problem — the
  // response the caller gets back is always the correct rolled-up value — but returning 200 with a
  // body that silently doesn't match what was PATCHed is a worse failure than refusing the write
  // outright and saying why. FR-TRK-04's "manual override at the parent level" is the sanctioned
  // way to do this for % complete and is out of scope for P1 — see `rollupFromChildren`.
  const rollupOwnedFields = (['start', 'durationHours', 'pctComplete'] as const).filter((field) =>
    has(field),
  );
  if (rollupOwnedFields.length > 0 && children.length > 0) {
    throw validationFailed(
      {
        fieldErrors: Object.fromEntries(
          rollupOwnedFields.map((field) => [
            field,
            [`FR-TSK-03: a summary task rolls ${field} up from its children; edit a leaf instead`],
          ]),
        ),
      },
      'A summary task rolls this field up from its children',
    );
  }
  if (intent.isMilestone === true && children.length > 0) {
    throw validationFailed(
      { fieldErrors: { isMilestone: ['FR-TSK-04: a milestone cannot have children'] } },
      'A milestone cannot be a summary task',
    );
  }

  const merged: TaskDto = {
    ...before,
    name: intent.name ?? before.name,
    durationHours: intent.durationHours ?? before.durationHours,
    start: has('start') ? (intent.start ?? before.start) : before.start,
    isMilestone: intent.isMilestone ?? before.isMilestone,
    scheduleMode: intent.scheduleMode ?? before.scheduleMode,
    constraintType: intent.constraintType ?? before.constraintType,
    constraintDate: has('constraintDate') ? intent.constraintDate! : before.constraintDate,
    calendarId: has('calendarId') ? intent.calendarId! : before.calendarId,
    priority: intent.priority ?? before.priority,
    pctComplete: intent.pctComplete ?? before.pctComplete,
    actualStart: has('actualStart') ? intent.actualStart! : before.actualStart,
    actualFinish: has('actualFinish') ? intent.actualFinish! : before.actualFinish,
    notes: intent.notes ?? before.notes,
    status: intent.status ?? before.status,
    updatedAt: envelope.issuedAt,
    updatedBy: envelope.actorUserId,
  };
  // A leaf's finish follows its own start and duration. A summary task's dates are overwritten by
  // the rollup below whatever is written here, which is why `recomputeChain` starts at this task
  // rather than at its parent.
  merged.finish = new Date(Date.parse(merged.start) + MS(merged.durationHours)).toISOString();
  validateCandidate(merged);

  const { rows } = await exec.query<TaskRow>(
    `UPDATE task
        SET name = $2, duration_hours = $3, start = $4, finish = $5, pct_complete = $6,
            is_milestone = $7, schedule_mode = $8, constraint_type = $9, constraint_date = $10,
            calendar_id = $11, priority = $12, actual_start = $13, actual_finish = $14,
            notes = $15, status = $16, updated_at = $17, updated_by = $18
      WHERE id = $1
      RETURNING ${TASK_SELECT}`,
    [
      merged.id,
      merged.name,
      merged.durationHours,
      merged.start,
      merged.finish,
      merged.pctComplete,
      merged.isMilestone,
      merged.scheduleMode,
      merged.constraintType,
      merged.constraintDate,
      merged.calendarId,
      merged.priority,
      merged.actualStart,
      merged.actualFinish,
      merged.notes,
      merged.status,
      merged.updatedAt,
      merged.updatedBy,
    ],
  );
  changes.record(merged.id, before, toTask(rows[0]!));

  await recomputeChain(exec, envelope, merged.id, changes);
  const after = await requireTask(exec, projectId, merged.id);
  return toTask(after);
}

async function applyReparent(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
  changes: ChangeSet,
): Promise<TaskDto> {
  const intent = envelope.intent;
  if (intent.kind !== 'reparentTask') throw new Error('unreachable');
  const projectId = envelope.projectId;

  const row = await requireTask(exec, projectId, intent.taskId);
  const before = toTask(row);
  const oldParentId = row.parent_id;

  // FR-TSK-02. The database's `task_not_own_parent` check only catches the one-level case; a task
  // moved under its own grandchild is just as much a cycle and is only visible from the tree.
  if (intent.newParentId !== null) {
    if (await isSelfOrDescendant(exec, projectId, row.id, intent.newParentId)) {
      throw validationFailed(
        {
          fieldErrors: { newParentId: ['FR-TSK-02: a task cannot be moved under its own subtree'] },
        },
        'That move would make the task its own ancestor',
      );
    }
  }
  const newParent =
    intent.newParentId === null ? null : await requireTask(exec, projectId, intent.newParentId);
  assertNotMilestoneParent(newParent);

  if (oldParentId !== (newParent?.id ?? null)) {
    const { rows } = await exec.query<TaskRow>(
      `UPDATE task SET parent_id = $2, updated_at = $3, updated_by = $4
        WHERE id = $1 RETURNING ${TASK_SELECT}`,
      [row.id, newParent?.id ?? null, envelope.issuedAt, envelope.actorUserId],
    );
    changes.record(row.id, before, toTask(rows[0]!));
  }

  // The moved task takes `newIndex`'s position among its new siblings, appending when omitted.
  // Both sibling sets are then renumbered contiguously: the destination so the insert has a free
  // ordinal, the origin so the hole the move left does not persist in the WBS.
  const destinationSiblings = (await loadChildren(exec, projectId, newParent?.id ?? null))
    .map((child) => child.id)
    .filter((id) => id !== row.id);
  const insertAt = Math.min(
    intent.newIndex ?? destinationSiblings.length,
    destinationSiblings.length,
  );
  destinationSiblings.splice(insertAt, 0, row.id);
  await renumberChildren(exec, envelope, newParent, destinationSiblings, changes);

  if (oldParentId !== (newParent?.id ?? null)) {
    const oldParent = oldParentId === null ? null : await loadTask(exec, projectId, oldParentId);
    const originSiblings = await loadChildren(exec, projectId, oldParentId);
    await renumberChildren(
      exec,
      envelope,
      oldParent,
      originSiblings.map((child) => child.id),
      changes,
    );
  }

  // FR-TSK-03 on both chains: the origin loses a child's dates, the destination gains them.
  await recomputeChain(exec, envelope, oldParentId, changes);
  await recomputeChain(exec, envelope, newParent?.id ?? null, changes);

  return toTask(await requireTask(exec, projectId, row.id));
}

async function applyDelete(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
  changes: ChangeSet,
): Promise<null> {
  const intent = envelope.intent;
  if (intent.kind !== 'deleteTask') throw new Error('unreachable');
  const projectId = envelope.projectId;

  const row = await requireTask(exec, projectId, intent.taskId);
  const parentId = row.parent_id;
  const children = await loadChildren(exec, projectId, row.id);

  // FR-TSK-08: the two failure modes are deliberately distinguishable, so a client can react
  // without having to fetch the task first to work out which one it is about to hit.
  if (children.length > 0 && intent.childPolicy === undefined) {
    throw validationFailed(
      {
        fieldErrors: {
          childPolicy: ['FR-TSK-08: deleting a task with children requires an explicit policy'],
        },
      },
      'This task has children; choose cascade or reparentToGrandparent',
    );
  }
  if (children.length === 0 && intent.childPolicy !== undefined) {
    throw conflict('This task has no children, so a child policy does not apply');
  }

  // FR-TSK-08 cascade: `task.parent_id` is `ON DELETE RESTRICT` on purpose (see 0001_init.sql) —
  // a database-level cascade would make the user's choice unreachable — so the subtree is removed
  // here, deepest first.
  //
  // FR-TSK-09 needs no code: `dependency.predecessor_id` and `dependency.successor_id` are both
  // `ON DELETE CASCADE`, so a deleted task's links go with it. There are no dependencies to remove
  // in P1 in any case (P2 owns them), and writing a DELETE against an always-empty table would be
  // dead code pretending to be a feature.
  if (intent.childPolicy === 'reparentToGrandparent') {
    const grandparent = parentId === null ? null : await loadTask(exec, projectId, parentId);
    const siblings = await loadChildren(exec, projectId, parentId);
    const position = siblings.findIndex((sibling) => sibling.id === row.id);

    for (const child of children) {
      const childBefore = toTask(child);
      const { rows } = await exec.query<TaskRow>(
        `UPDATE task SET parent_id = $2, updated_at = $3, updated_by = $4
          WHERE id = $1 RETURNING ${TASK_SELECT}`,
        [child.id, parentId, envelope.issuedAt, envelope.actorUserId],
      );
      changes.record(child.id, childBefore, toTask(rows[0]!));
    }

    // The row goes before the renumber, not after: it still holds a WBS code its promoted
    // children are about to be given, and `UNIQUE (project_id, wbs_code)` does not wait.
    changes.record(row.id, toTask(row), null);
    await exec.query(`DELETE FROM task WHERE id = $1`, [row.id]);

    // The promoted children take the deleted task's place in the sibling order.
    const ordered = siblings.map((sibling) => sibling.id).filter((id) => id !== row.id);
    ordered.splice(
      position < 0 ? ordered.length : position,
      0,
      ...children.map((child) => child.id),
    );
    await renumberChildren(exec, envelope, grandparent, ordered, changes);
  } else {
    const doomed =
      intent.childPolicy === 'cascade'
        ? await loadSubtreeDeepestFirst(exec, projectId, row.id)
        : [row];
    for (const victim of doomed) {
      changes.record(victim.id, toTask(victim), null);
      await exec.query(`DELETE FROM task WHERE id = $1`, [victim.id]);
    }
  }

  // The parent keeps whatever the last rollup left it: with no children it is a leaf again, and a
  // leaf's fields are exactly what was written to it.
  await recomputeChain(exec, envelope, parentId, changes);
  return null;
}

// ----------------------------------------------------------------------------------------------
// The entry point
// ----------------------------------------------------------------------------------------------

/**
 * The only function permitted to write `task.start`, `task.finish` and the rollup-derived columns
 * (invariant 2).
 *
 * One envelope in, one description of everything that changed out. No `deps` parameter and no
 * clock read: `envelope.issuedAt` is the API's clock, captured once when the request arrived
 * (`intents.ts`), so replaying an envelope through a P3 queue produces the same timestamps rather
 * than the time it happened to be dequeued.
 *
 * Callers wrap this in `auditedMutation` — the returned `changes` are exactly the audit rows the
 * mutation owes (invariant 4), including the ancestors that moved as a rollup side effect.
 */
export async function applyTaskIntent(
  exec: SqlExecutor,
  envelope: MutationIntentEnvelope,
): Promise<ApplyTaskIntentResult> {
  const changes = new ChangeSet();

  switch (envelope.intent.kind) {
    case 'createTask':
      return { task: await applyCreate(exec, envelope, changes), changes: changes.list() };
    case 'updateTask':
      return { task: await applyUpdate(exec, envelope, changes), changes: changes.list() };
    case 'reparentTask':
      return { task: await applyReparent(exec, envelope, changes), changes: changes.list() };
    case 'deleteTask':
      return { task: await applyDelete(exec, envelope, changes), changes: changes.list() };
  }
}
