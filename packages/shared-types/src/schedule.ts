import { z } from 'zod';
import { durationHoursSchema, isoDateTimeSchema, taskIdSchema } from './primitives.js';

/**
 * Computed schedule state — the *output* projection of the CPM engine, per task.
 *
 * This is deliberately separate from `Task` in `entities.ts`. A task's stored `start`/`finish`
 * are what the engine last wrote; these fields are what the engine *derived* and are recomputed
 * from the graph, never edited by a user. Modelling them as task columns invites someone to
 * PATCH `totalFloatHours`, and float that can be set by hand is not float.
 *
 * ## Where the rest of the engine contract lives (updated at P2 entry)
 *
 * The full `cpm-engine` contract — the input graph shape, the recalculation result envelope, and
 * the incremental-recompute request/result — was a **P2 entry deliverable** and now lives in
 * `cpm.ts` (ADR-010). It was not written in P0 because nothing in P0 or P1 consumed it: the engine
 * did not exist until P2, so any shape written then would have been an unvalidated guess. What P0
 * needed, and all it needed, is the per-task projection below, because the Gantt view model has to
 * carry critical-path membership from the moment the adapter contract exists (FR-SCH-10).
 *
 * `CpmTaskSchedule` in `cpm.ts` extends this projection with the three fields that are persisted
 * back onto the `task` row (`start`, `finish`, `durationHours`). The split is intentional: those
 * three are task columns with an existing write path, these are engine-owned analysis that lands
 * in its own table and is never PATCHable.
 *
 * Likewise the **mutation-intent envelope** (ADR-002) and the **WebSocket delta format** are P2/P3
 * entry deliverables. The one open question that forces the envelope earlier is recorded as a
 * P1-entry decision: whether P1's task CRUD writes dates directly from `apps/api` or goes through
 * a minimal in-process scheduler. Writing dates from two places is how the second source of truth
 * gets created, so that decision precedes P1 implementation.
 */

export const taskScheduleComputedSchema = z.object({
  taskId: taskIdSchema,
  /** FR-SCH-04 forward pass. */
  earlyStart: isoDateTimeSchema,
  earlyFinish: isoDateTimeSchema,
  /** FR-SCH-04 backward pass. */
  lateStart: isoDateTimeSchema,
  lateFinish: isoDateTimeSchema,
  /** FR-SCH-05: Total Float = LS - ES, in hours. May be negative on an over-constrained project. */
  totalFloatHours: z.number().finite(),
  /**
   * FR-SCH-05 (docs/FRS.md v1.2): `float <= 0`, not `=== 0`. On an over-constrained project (an
   * unmeetable SNLT/FNLT, or a summary whose most-constrained child has negative float) nothing
   * has exactly zero float, and the strict reading would leave FR-SCH-10 with no path to
   * highlight precisely when a user most needs to see one. Rendered red in the Gantt and
   * filterable in the grid (FR-SCH-10).
   */
  isCritical: z.boolean(),
  /**
   * FR-SCH-08: a manually-scheduled task whose fixed dates conflict with its predecessors. The
   * task does not move; it is flagged. Also set when a hard constraint (FR-TSK-06) cannot be met.
   */
  hasScheduleConflict: z.boolean(),
});
export type TaskScheduleComputed = z.infer<typeof taskScheduleComputedSchema>;

/** Perf budgets from FR-SCH-06 and FR-VIEW-02, as machine-readable constants. */
export const PERF_BUDGETS = Object.freeze({
  /** Full-project recalculation, p95, at 5,000 tasks. */
  fullRecalcMs: 500,
  fullRecalcTaskCount: 5000,
  /** Incremental (dirty-subgraph) recalculation for a typical single-task edit, any project size. */
  incrementalRecalcMs: 150,
  /** Gantt initial paint at 2,000 simultaneously visible tasks. */
  ganttInitialPaintMs: 1000,
  ganttVisibleTaskCount: 2000,
  /** Interaction frame budget — 60fps. */
  interactionFrameMs: 16,
  /** FR-COL-01: same-region propagation of another user's edit. */
  realtimePropagationMs: 200,
} as const);

export const durationHoursOrNullSchema = durationHoursSchema.nullable();
