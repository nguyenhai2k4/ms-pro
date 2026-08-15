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
 * ## What is deliberately not here (scope boundary)
 *
 * The full `cpm-engine` contract — the input graph shape, the recalculation result envelope, and
 * the incremental-recompute delta — is a **P2 entry deliverable**, owned by `tech-lead` with
 * `scheduler-engineer`, and it is not defined in P0. Nothing in P0 or P1 consumes it: the engine
 * does not exist until P2, so any shape written now would be an unvalidated guess that P2 rewrites.
 * What P0 needs, and all it needs, is the per-task projection below, because the Gantt view model
 * has to carry critical-path membership from the moment the adapter contract exists (FR-SCH-10).
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
  /** FR-SCH-05: float === 0. Rendered red in the Gantt and filterable in the grid (FR-SCH-10). */
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
