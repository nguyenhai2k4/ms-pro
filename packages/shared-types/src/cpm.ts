import { z } from 'zod';
import {
  constraintTypeSchema,
  dependencyTypeSchema,
  scheduleModeSchema,
  weekdaySchema,
} from './enums.js';
import {
  calendarIdSchema,
  dependencyIdSchema,
  durationHoursSchema,
  isoDateSchema,
  isoDateTimeSchema,
  lagHoursSchema,
  projectIdSchema,
  taskIdSchema,
} from './primitives.js';
import { taskScheduleComputedSchema } from './schedule.js';

/**
 * The `packages/cpm-engine` interface contract — **P2 entry deliverable** (the one
 * `schedule.ts` and `index.ts` both name as deliberately absent until now).
 *
 * `schedule.ts` already owns the per-task *projection* (`TaskScheduleComputed`) that the Gantt
 * view model has carried since P0. This file adds the three things P2 needs and P0/P1 correctly
 * refused to guess: the **input graph**, the **result envelope**, and the **incremental-recompute
 * request/result**. See ADR-010 for the reasoning behind each shape and ADR-011 for the
 * time-zone pin.
 *
 * ## Purity is expressed in the types, not just in prose
 *
 * `CLAUDE.md` invariant 1 says the engine takes a graph in and returns a schedule out: no DB
 * calls, no clock reads, no randomness, same input -> byte-identical output. Three properties of
 * this contract make that structural rather than aspirational:
 *
 *  1. **`ComputeSchedule` and `RecomputeSchedule` are synchronous.** A function that cannot
 *     return a promise cannot await a query. This is the cheapest possible enforcement of "no
 *     I/O" and it is why the signatures live here rather than being left to the implementation.
 *  2. **Calendars are resolved into the input.** The engine never looks a calendar up; the caller
 *     passes every calendar the graph references, exceptions included. A missing one is a
 *     diagnostic, not a fetch.
 *  3. **Incremental recompute takes the previous result as an argument.** There is no module-level
 *     cache in `packages/cpm-engine`. The per-project in-memory graph cache described in
 *     `docs/IMPLEMENTATION-PLAN.md` §1 belongs to the *caller* (`apps/api` in P2, the standalone
 *     Scheduler Service in P3) — a cache inside a pure function is state, and state is how
 *     "same input -> same output" stops being true.
 *
 * There is also no `elapsedMs` anywhere in the result. Timing the engine requires reading a
 * clock, so the perf harness times the call from the outside; `CpmMetrics` carries counts only.
 *
 * ## Determinism of ordering
 *
 * "Byte-identical" is only meaningful if array order is pinned. Every array in a result is in a
 * **canonical order** — task-keyed arrays ascending by `taskId`, dependency-keyed arrays ascending
 * by `dependencyId`, diagnostics by `(code, primary id)` — so permuting the *input* arrays cannot
 * change the output. This is a contract requirement on the implementation and a property test,
 * not a hint.
 *
 * ## What is still deliberately not here
 *
 *  - **The WebSocket delta format.** `CpmIncrementalResult.changedTaskIds` is the engine's answer
 *    to "what moved". Turning that into a wire message with a per-project sequence number, client
 *    acks and presence is FR-COL-01..04 and stays a **P3 entry deliverable** (ADR-002). P2 must
 *    not open a socket.
 *  - **Free float, resource-levelled dates, baselines.** FR-SCH-05 needs total float only;
 *    FR-RES-05/06 and FR-TRK are later phases. Adding fields now repeats exactly the mistake
 *    `schedule.ts` avoided by not writing this file in P0.
 *  - **Backward scheduling from a deadline.** FR-SCH-09 tags it P2-the-product-phase, not
 *    P2-the-roadmap-phase. `CpmScheduleDirection` is a one-member enum so adding `'backward'`
 *    later is additive rather than a reshape.
 */

// ---------------------------------------------------------------------------------------------
// Input: calendars (FR-SCH-07, FR-CAL-01/02, FR-TSK-07)
// ---------------------------------------------------------------------------------------------

/**
 * FR-CAL-02. Mirrors `calendar_exception`: `isWorking: false` is a holiday, `true` with overrides
 * is a half-day. Overrides are minutes from midnight **UTC** (ADR-011).
 */
export const cpmCalendarExceptionSchema = z
  .object({
    date: isoDateSchema,
    isWorking: z.boolean(),
    startMinuteOverride: z.number().int().min(0).max(1440).nullable(),
    endMinuteOverride: z.number().int().min(0).max(1440).nullable(),
  })
  .strict();
export type CpmCalendarException = z.infer<typeof cpmCalendarExceptionSchema>;

/**
 * A calendar as the engine sees it: fully resolved, exceptions inlined, no id to dereference.
 *
 * `workingDays` may be **empty** and is not rejected here. A calendar with no working days is
 * reachable through FR-CAL-01's editing endpoint, and an engine that threw on it would turn a
 * user's bad input into a 500. It produces an `unusable_calendar` diagnostic instead — which is
 * also the guard that stops "advance to the next working minute" from looping forever.
 */
export const cpmCalendarSchema = z
  .object({
    id: calendarIdSchema,
    /** ISO weekday numbers, 1 = Monday, derived in **UTC** (ADR-011). */
    workingDays: z.array(weekdaySchema),
    /** Minutes from midnight **UTC** (ADR-011). The engine performs no time-zone conversion. */
    workingHoursStartMinute: z.number().int().min(0).max(1440),
    workingHoursEndMinute: z.number().int().min(0).max(1440),
    exceptions: z.array(cpmCalendarExceptionSchema),
  })
  .strict();
export type CpmCalendar = z.infer<typeof cpmCalendarSchema>;

// ---------------------------------------------------------------------------------------------
// Input: tasks and dependencies (FR-TSK-02..07, FR-SCH-01/02)
// ---------------------------------------------------------------------------------------------

/**
 * A task as the engine sees it. Deliberately a *narrower* projection than the `Task` entity: no
 * name, notes, status, `pctComplete` or `actualStart`. Those cannot affect a schedule, and a
 * field the engine can read is a field a future change can accidentally schedule on. FR-VIEW-06
 * makes this concrete — dragging a Kanban card must not move dates, which is structurally true
 * when `status` never reaches the engine.
 *
 * `parentId` *is* here: FR-TSK-03 summary rollup is part of scheduling and moves to this engine in
 * P2, retiring the wall-clock arithmetic in `apps/api/src/scheduler/rollup.ts`.
 */
export const cpmTaskSchema = z
  .object({
    id: taskIdSchema,
    /** FR-TSK-02. Null for a top-level task. A task with children is a summary task. */
    parentId: taskIdSchema.nullable(),
    /** FR-TSK-01. Ignored for a summary task, whose duration is derived from its children. */
    durationHours: durationHoursSchema,
    /** FR-TSK-04. A milestone has duration 0 and finish === start. */
    isMilestone: z.boolean(),
    /** FR-TSK-05. `manual` tasks do not move; they still roll up and can still be critical. */
    scheduleMode: scheduleModeSchema,
    /** FR-TSK-06. */
    constraintType: constraintTypeSchema,
    /** FR-TSK-06. Non-null exactly when `constraintType` is not ASAP/ALAP. */
    constraintDate: isoDateTimeSchema.nullable(),
    /** FR-TSK-07. Null inherits `CpmScheduleInput.defaultCalendarId`. */
    calendarId: calendarIdSchema.nullable(),
    /**
     * FR-TSK-05. The user's fixed dates for a `manual` task — required when `scheduleMode` is
     * `manual`, ignored when `auto`. Passing the stored row's dates for an auto task would let a
     * stale value influence the computation, which is how a recompute stops being a function of
     * the graph alone.
     */
    manualStart: isoDateTimeSchema.nullable(),
    manualFinish: isoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (
      task.scheduleMode === 'manual' &&
      (task.manualStart === null || task.manualFinish === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manualStart'],
        message: 'FR-TSK-05: a manually-scheduled task requires manualStart and manualFinish',
      });
    }
    const dated = task.constraintType !== 'ASAP' && task.constraintType !== 'ALAP';
    if (dated && task.constraintDate === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['constraintDate'],
        message: `FR-TSK-06: constraint ${task.constraintType} requires a constraintDate`,
      });
    }
  });
export type CpmTask = z.infer<typeof cpmTaskSchema>;

/** FR-SCH-01, FR-SCH-02. Same shape as the `Dependency` entity minus `projectId`/`createdAt`. */
export const cpmDependencySchema = z
  .object({
    id: dependencyIdSchema,
    predecessorId: taskIdSchema,
    successorId: taskIdSchema,
    type: dependencyTypeSchema,
    /** FR-SCH-02: signed working hours. Negative is lead. Applied on the successor's calendar. */
    lagHours: lagHoursSchema,
  })
  .strict();
export type CpmDependency = z.infer<typeof cpmDependencySchema>;

/**
 * FR-SCH-09. Forward-from-a-fixed-start is MVP; backward-from-a-deadline is tagged **P2 in the
 * FRS's product-phase sense**, which is not this roadmap phase. Modelled as an enum so the later
 * addition is a new member rather than a new field.
 */
export const cpmScheduleDirectionSchema = z.enum(['forward']);
export type CpmScheduleDirection = z.infer<typeof cpmScheduleDirectionSchema>;

/**
 * Everything the engine is allowed to know. If a computation needs something that is not in here,
 * that is an interface change and it escalates (`CLAUDE.md` invariant 7) — it is never a lookup.
 */
export const cpmScheduleInputSchema = z
  .object({
    projectId: projectIdSchema,
    /** FR-SCH-09: the project's fixed start. Also the engine's only notion of "now". */
    projectStart: isoDateTimeSchema,
    direction: cpmScheduleDirectionSchema,
    /** FR-TSK-07: used by every task whose own `calendarId` is null. */
    defaultCalendarId: calendarIdSchema,
    /** Every calendar referenced by `defaultCalendarId` or any task. Order is not significant. */
    calendars: z.array(cpmCalendarSchema),
    tasks: z.array(cpmTaskSchema),
    dependencies: z.array(cpmDependencySchema),
  })
  .strict();
export type CpmScheduleInput = z.infer<typeof cpmScheduleInputSchema>;

// ---------------------------------------------------------------------------------------------
// Output: diagnostics
// ---------------------------------------------------------------------------------------------

/**
 * `error` rejects the whole computation (`status: 'rejected'`, no schedule produced, caller rolls
 * the mutation back). `warning` is a schedule the engine *did* produce that the user needs to see
 * — it sets `hasScheduleConflict` on the affected task rather than refusing the edit.
 *
 * The split matters for FR-SCH-08: a manual task whose predecessor now finishes late is a warning,
 * because the requirement says the task must *not* move and must be *flagged*. Rejecting that edit
 * would be a different product.
 */
export const cpmDiagnosticSeveritySchema = z.enum(['error', 'warning']);
export type CpmDiagnosticSeverity = z.infer<typeof cpmDiagnosticSeveritySchema>;

/**
 * FR-SCH-03: "reject ... with a clear error identifying the cycle". `cyclePath` is the ordered
 * task ids around the loop with the entry task repeated at the end (`[a, b, c, a]`), and
 * `cycleDependencyIds` is the edge list in the same order, so the client can highlight the exact
 * arrows without re-deriving them. The API surfaces this as `dependency_cycle` with
 * `details.cyclePath` — the error code and field name `http.ts` already reserved in P0.
 */
export const cpmCycleDiagnosticSchema = z
  .object({
    code: z.literal('dependency_cycle'),
    severity: z.literal('error'),
    cyclePath: z.array(taskIdSchema).min(2),
    cycleDependencyIds: z.array(dependencyIdSchema).min(1),
  })
  .strict();

/** An edge naming a task that is not in `tasks`, or a self-link that slipped past the DB check. */
export const cpmDanglingDependencyDiagnosticSchema = z
  .object({
    code: z.literal('dangling_dependency'),
    severity: z.literal('error'),
    dependencyId: dependencyIdSchema,
    missingTaskId: taskIdSchema,
  })
  .strict();

/** A task naming a calendar that is not in `calendars`. Never a fetch — see the header. */
export const cpmMissingCalendarDiagnosticSchema = z
  .object({
    code: z.literal('missing_calendar'),
    severity: z.literal('error'),
    calendarId: calendarIdSchema,
    taskId: taskIdSchema.nullable(),
  })
  .strict();

/** A calendar with no working day in it. The termination guard for working-time advancement. */
export const cpmUnusableCalendarDiagnosticSchema = z
  .object({
    code: z.literal('unusable_calendar'),
    severity: z.literal('error'),
    calendarId: calendarIdSchema,
  })
  .strict();

/**
 * FR-TSK-06: a hard constraint (MSO/MFO, or a SNLT/FNLT the predecessors overrun) that the graph
 * cannot satisfy. The engine still schedules — it honours the constraint and lets float go
 * negative — and flags the task. `requiredDate` is what the constraint demands; `computedDate` is
 * what the predecessors imply.
 */
export const cpmConstraintViolationDiagnosticSchema = z
  .object({
    code: z.literal('constraint_violation'),
    severity: z.literal('warning'),
    taskId: taskIdSchema,
    constraintType: constraintTypeSchema,
    requiredDate: isoDateTimeSchema,
    computedDate: isoDateTimeSchema,
  })
  .strict();

/**
 * FR-SCH-08: a manually-scheduled task whose fixed dates conflict with a predecessor. The task
 * does not move. `earliestFeasibleStart` is what the task's dates *would* have been so the client
 * can offer "switch to auto" as a one-click fix rather than making the user work it out.
 */
export const cpmManualConflictDiagnosticSchema = z
  .object({
    code: z.literal('manual_conflict'),
    severity: z.literal('warning'),
    taskId: taskIdSchema,
    dependencyId: dependencyIdSchema,
    predecessorId: taskIdSchema,
    earliestFeasibleStart: isoDateTimeSchema,
  })
  .strict();

export const cpmDiagnosticSchema = z.discriminatedUnion('code', [
  cpmCycleDiagnosticSchema,
  cpmDanglingDependencyDiagnosticSchema,
  cpmMissingCalendarDiagnosticSchema,
  cpmUnusableCalendarDiagnosticSchema,
  cpmConstraintViolationDiagnosticSchema,
  cpmManualConflictDiagnosticSchema,
]);
export type CpmDiagnostic = z.infer<typeof cpmDiagnosticSchema>;

/** The diagnostic codes that reject the computation. Exported so callers branch on data, not prose. */
export const CPM_ERROR_DIAGNOSTIC_CODES = Object.freeze([
  'dependency_cycle',
  'dangling_dependency',
  'missing_calendar',
  'unusable_calendar',
] as const);

// ---------------------------------------------------------------------------------------------
// Output: per-task schedule
// ---------------------------------------------------------------------------------------------

/**
 * What the engine computed for one task: `schedule.ts`'s projection (ES/EF/LS/LF, total float,
 * critical, conflict) plus the three fields that get **persisted back onto the task row**.
 *
 * The split is the point. `start`/`finish`/`durationHours` are the task's dates, which already
 * exist as columns and which `applyScheduleIntent` already owns as the single write path (ADR-007).
 * ES/EF/LS/LF/float are engine-derived analysis that must never be user-settable — `schedule.ts`
 * says why — and they land in their own engine-owned table (`task_schedule`, migration 0003), not
 * as task columns. One result row, two destinations, no second source of truth.
 *
 * For an `auto` task `start === earlyStart` and `finish === earlyFinish`. For a `manual` task they
 * are the user's fixed dates while ES/EF still report where the graph would have put it — which is
 * exactly what makes FR-SCH-08's conflict flag computable and FR-TSK-05's "can still appear on the
 * critical path" true.
 */
export const cpmTaskScheduleSchema = taskScheduleComputedSchema
  .extend({
    /** Persisted to `task.start`. */
    start: isoDateTimeSchema,
    /** Persisted to `task.finish`. */
    finish: isoDateTimeSchema,
    /**
     * Persisted to `task.duration_hours`. For a leaf this is the input duration; for a summary
     * task it is the **working-hours** span of its children (FR-SCH-07), not the wall-clock span
     * P1's rollup produced.
     */
    durationHours: durationHoursSchema,
  })
  .strict();
export type CpmTaskSchedule = z.infer<typeof cpmTaskScheduleSchema>;

/** Counts only — no timings, because reading a clock is a purity violation. See the header. */
export const cpmMetricsSchema = z
  .object({
    tasksScheduled: z.number().int().nonnegative(),
    dependenciesTraversed: z.number().int().nonnegative(),
    /** Longest chain in the topological order. The perf tests correlate against this, not task count. */
    topologicalDepth: z.number().int().nonnegative(),
  })
  .strict();
export type CpmMetrics = z.infer<typeof cpmMetricsSchema>;

/**
 * A successful computation. `taskSchedules` covers **every** task in the input, ascending by
 * `taskId` — a partial result would force every caller to decide what an absent task means.
 */
export const cpmScheduledResultSchema = z
  .object({
    status: z.literal('scheduled'),
    projectId: projectIdSchema,
    taskSchedules: z.array(cpmTaskScheduleSchema),
    /**
     * FR-SCH-05 / FR-VIEW-01: edges where both endpoints are critical *and* the edge is driving.
     * `GanttDependencyView.isCritical` has existed since P0 with nothing to populate it; this is
     * that source. Derivable client-side, but deriving "driving" needs the lag arithmetic the
     * engine just did, and a second implementation of it is a second answer.
     */
    criticalDependencyIds: z.array(dependencyIdSchema),
    /** max(earlyFinish). The Gantt time axis and FR-TRK variance both need it. */
    projectFinish: isoDateTimeSchema,
    /** Warnings only — an error-severity diagnostic makes the result `rejected`. */
    diagnostics: z.array(cpmDiagnosticSchema),
    metrics: cpmMetricsSchema,
  })
  .strict();

/**
 * FR-SCH-03: no schedule, no partial state. The caller aborts the transaction and the previously
 * stored schedule stands untouched. There is deliberately no `partialTaskSchedules` field — a
 * half-applied recompute is the silent-corruption failure mode this phase exists to avoid.
 */
export const cpmRejectedResultSchema = z
  .object({
    status: z.literal('rejected'),
    projectId: projectIdSchema,
    diagnostics: z.array(cpmDiagnosticSchema).min(1),
  })
  .strict();

export const cpmScheduleResultSchema = z.discriminatedUnion('status', [
  cpmScheduledResultSchema,
  cpmRejectedResultSchema,
]);
export type CpmScheduleResult = z.infer<typeof cpmScheduleResultSchema>;
export type CpmScheduledResult = z.infer<typeof cpmScheduledResultSchema>;
export type CpmRejectedResult = z.infer<typeof cpmRejectedResultSchema>;

// ---------------------------------------------------------------------------------------------
// Incremental recompute (FR-SCH-04 "affected connected subgraph", FR-SCH-06 <150ms)
// ---------------------------------------------------------------------------------------------

/**
 * FR-SCH-04 lists exactly what dirties a schedule: task duration/dates, dependency
 * add/remove/change, calendar change, constraint change. Naming them individually rather than
 * passing an opaque "dirty task ids" list is what lets the engine seed the traversal correctly —
 * a calendar edit dirties every task bound to that calendar, which the caller should not have to
 * work out, and a dependency deletion dirties a node the edge no longer points at.
 */
export const cpmDirtySetSchema = z
  .object({
    /** Tasks whose duration, mode, constraint, calendar or manual dates changed; plus new tasks. */
    taskIds: z.array(taskIdSchema),
    /** Dependencies added, removed or retyped/re-lagged. Removed edges are named by their old id. */
    dependencyIds: z.array(dependencyIdSchema),
    /** FR-CAL-01/02: a working-pattern or exception change. Dirties every task using it. */
    calendarIds: z.array(calendarIdSchema),
    /** Tasks removed by this mutation (FR-TSK-08/09). Absent from `input.tasks`. */
    removedTaskIds: z.array(taskIdSchema),
    /** True when the project's own start date or calendar changed — forces a full pass. */
    projectSettingsChanged: z.boolean(),
  })
  .strict();
export type CpmDirtySet = z.infer<typeof cpmDirtySetSchema>;

/**
 * `input` is the **complete post-mutation graph**, not a fragment. That looks wasteful and is not:
 * assembling it from a cache the caller already holds is cheap, and the perf win FR-SCH-06 asks
 * for is in the *computation* (topological sort from the changed node) rather than in the
 * marshalling. A fragment-based interface would additionally make the "incremental equals full"
 * property untestable, and that property is the single highest-yield guard in this phase.
 *
 * ## Where FR-SCH-06's 150ms is measured, precisely
 *
 * At **this function's boundary**: request in, result out. Loading 5,000 rows out of Postgres to
 * build `input` is not inside that budget and will not fit inside it, which is why
 * `docs/IMPLEMENTATION-PLAN.md` §1 puts an in-memory per-project graph in the Scheduler Service.
 * That service is P3. P2 therefore meets FR-SCH-06 **at the engine boundary** and says so; the
 * end-to-end HTTP number is a P3/P8 measurement. Anyone reporting FR-SCH-06 as met end-to-end from
 * P2 evidence is reporting the wrong number.
 */
export const cpmRecalcRequestSchema = z
  .object({
    input: cpmScheduleInputSchema,
    /** The last `scheduled` result for this project. A `rejected` one was never persisted. */
    previous: cpmScheduledResultSchema,
    dirty: cpmDirtySetSchema,
  })
  .strict();
export type CpmRecalcRequest = z.infer<typeof cpmRecalcRequestSchema>;

/**
 * `result` is a **whole** schedule, not a patch: untouched tasks are carried over from `previous`
 * verbatim. That is what makes the phase's headline invariant a literal deep-equality —
 *
 *     recomputeSchedule({ input, previous, dirty }).result  ===  computeSchedule(input)
 *
 * — for every mutation, on every graph. `changedTaskIds` is the engine's answer to "what actually
 * moved", and it is what the caller persists and audits: writing 5,000 rows and 5,000 audit
 * entries because one leaf shifted is how invariant 4 turns into a performance incident.
 *
 * `changedTaskIds` is a *value* comparison against `previous`, not a record of which nodes were
 * visited. A task the traversal touched and left unchanged is not in it.
 */
export const cpmIncrementalResultSchema = z
  .object({
    result: cpmScheduleResultSchema,
    /** Ascending by `taskId`. Empty when the mutation moved nothing. */
    changedTaskIds: z.array(taskIdSchema),
    /** Nodes the traversal actually visited. Diagnostic value for the perf tests only. */
    visitedTaskCount: z.number().int().nonnegative(),
  })
  .strict();
export type CpmIncrementalResult = z.infer<typeof cpmIncrementalResultSchema>;

// ---------------------------------------------------------------------------------------------
// The engine's public function signatures
// ---------------------------------------------------------------------------------------------

/**
 * FR-SCH-04, FR-SCH-05, FR-SCH-07. **Synchronous by contract** — see the header: a function that
 * cannot return a promise cannot await a query, which makes invariant 1 a compile error rather
 * than a code-review finding.
 */
export type ComputeSchedule = (input: CpmScheduleInput) => CpmScheduleResult;

/** FR-SCH-04, FR-SCH-06. Same purity rules; same synchronous signature, for the same reason. */
export type RecomputeSchedule = (request: CpmRecalcRequest) => CpmIncrementalResult;

/**
 * FR-SCH-03, exposed separately because the dependency-create endpoint must reject a cycle
 * *before* it writes the row, and paying for a full schedule to answer a yes/no question is the
 * wrong shape. Returns the cycle diagnostic, or null when the edge is safe.
 */
export type DetectCycle = (
  tasks: readonly CpmTask[],
  dependencies: readonly CpmDependency[],
) => CpmDiagnostic | null;
