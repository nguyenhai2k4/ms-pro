import { z } from 'zod';
import { dependencyTypeSchema, scheduleModeSchema } from './enums.js';
import type { DependencyType } from './enums.js';
import {
  dependencyIdSchema,
  isoDateTimeSchema,
  lagHoursSchema,
  percentCompleteSchema,
  projectIdSchema,
  taskIdSchema,
} from './primitives.js';
import type { TaskId } from './primitives.js';

/**
 * # The Gantt rendering adapter contract (ADR-001, ADR-006)
 *
 * ADR-001 licenses a commercial Gantt for MVP and keeps it behind an internal adapter so the
 * renderer can be replaced later without touching the data model or the scheduling engine. This
 * file is that seam. It lives in `shared-types` rather than `apps/web` because it is a contract
 * that the view layer, the accessible table representation, and (from P3) the realtime delta
 * application all build against simultaneously.
 *
 * Three rules make the seam real rather than decorative:
 *
 * 1. **No vendor type appears here**, directly or structurally. If a shape in this file exists
 *    because Bryntum happens to model it that way, the exit ramp is already compromised.
 * 2. **The adapter renders; it never computes.** It receives a view model the server produced and
 *    draws it. It does not recalculate dates locally to feel faster and it does not decide what is
 *    critical — that is the server's answer (invariant 2, ADR-002). A drag *preview* is local; the
 *    resulting dates are not.
 * 3. **User gestures produce intents, not state.** Every callback below is named `...Intent` for
 *    that reason. The adapter proposes; the server disposes; the next `render()` is the truth. An
 *    adapter that mutates its own model on drag has forked the schedule.
 *
 * See ADR-006 for why `apps/web` ships a placeholder implementation in P0 and what gates the
 * vendor integration.
 */

export const ganttZoomSchema = z.enum(['day', 'week', 'month', 'quarter']);
export type GanttZoom = z.infer<typeof ganttZoomSchema>;

/** One row of the Gantt (FR-VIEW-01). A flattened tree — `depth` carries the WBS nesting. */
export const ganttTaskViewSchema = z.object({
  id: taskIdSchema,
  parentId: taskIdSchema.nullable(),
  wbsCode: z.string(),
  name: z.string(),
  start: isoDateTimeSchema,
  finish: isoDateTimeSchema,
  pctComplete: percentCompleteSchema,
  isMilestone: z.boolean(),
  isSummary: z.boolean(),
  scheduleMode: scheduleModeSchema,
  /** FR-SCH-05/10: server-computed. Never inferred client-side. */
  isCritical: z.boolean(),
  totalFloatHours: z.number().finite(),
  /** FR-SCH-08: render a warning affordance; do not move the bar. */
  hasScheduleConflict: z.boolean(),
  depth: z.number().int().nonnegative(),
  isCollapsed: z.boolean(),
  /** FR-TRK-02: baseline overlay bar. Null when no baseline is selected. */
  baseline: z
    .object({
      start: isoDateTimeSchema,
      finish: isoDateTimeSchema,
    })
    .nullable(),
});
export type GanttTaskView = z.infer<typeof ganttTaskViewSchema>;

/** A dependency arrow (FR-VIEW-01, FR-SCH-01/02). */
export const ganttDependencyViewSchema = z.object({
  id: dependencyIdSchema,
  predecessorId: taskIdSchema,
  successorId: taskIdSchema,
  type: dependencyTypeSchema,
  lagHours: lagHoursSchema,
  /** True when both endpoints are on the critical path — drawn red with the bars (FR-SCH-10). */
  isCritical: z.boolean(),
});
export type GanttDependencyView = z.infer<typeof ganttDependencyViewSchema>;

export const ganttTimeAxisSchema = z.object({
  zoom: ganttZoomSchema,
  rangeStart: isoDateTimeSchema,
  rangeEnd: isoDateTimeSchema,
});
export type GanttTimeAxis = z.infer<typeof ganttTimeAxisSchema>;

/**
 * The complete authoritative picture the adapter draws. `render()` is idempotent: given the same
 * model twice, the visible result is identical. That property is what lets a dropped WebSocket
 * delta be repaired by a full re-render rather than by reconciliation logic.
 */
export const ganttViewModelSchema = z.object({
  projectId: projectIdSchema,
  timeAxis: ganttTimeAxisSchema,
  tasks: z.array(ganttTaskViewSchema),
  dependencies: z.array(ganttDependencyViewSchema),
  /** Server-computed, in topological order from project start to finish. */
  criticalPathTaskIds: z.array(taskIdSchema),
  /**
   * Monotonic per project. Lets the client detect that it applied deltas out of order and ask
   * for a full re-render instead of drawing a schedule that never existed.
   */
  version: z.number().int().nonnegative(),
});
export type GanttViewModel = z.infer<typeof ganttViewModelSchema>;

// --------------------------------------------------------------------------------------------
// Intents — user gestures, expressed in domain terms
// --------------------------------------------------------------------------------------------

export interface GanttTaskMoveIntent {
  readonly kind: 'task:move';
  readonly taskId: TaskId;
  readonly newStart: string;
}

export interface GanttTaskResizeIntent {
  readonly kind: 'task:resize';
  readonly taskId: TaskId;
  readonly newStart: string;
  readonly newFinish: string;
}

export interface GanttTaskProgressIntent {
  readonly kind: 'task:progress';
  readonly taskId: TaskId;
  readonly pctComplete: number;
}

export interface GanttDependencyCreateIntent {
  readonly kind: 'dependency:create';
  readonly predecessorId: TaskId;
  readonly successorId: TaskId;
  readonly type: DependencyType;
}

export interface GanttDependencyDeleteIntent {
  readonly kind: 'dependency:delete';
  readonly predecessorId: TaskId;
  readonly successorId: TaskId;
}

/**
 * The closed set of gestures the renderer can originate. Mapping these onto the wire-level
 * mutation-intent envelope (ADR-002) happens in `apps/web`'s transport layer and is a P2/P3
 * deliverable — see the scope note in `schedule.ts`. Keeping the two separate means the Gantt
 * does not need to know the wire format, and the wire format does not need to know about drags.
 */
export type GanttIntent =
  | GanttTaskMoveIntent
  | GanttTaskResizeIntent
  | GanttTaskProgressIntent
  | GanttDependencyCreateIntent
  | GanttDependencyDeleteIntent;

export interface GanttAdapterCallbacks {
  /** A user gesture completed. The host sends it to the server; it does NOT apply it locally. */
  onIntent(intent: GanttIntent): void;
  onSelectionChange(taskIds: readonly TaskId[]): void;
  onViewportChange(viewport: GanttViewport): void;
  /** Row expand/collapse — a pure view concern, never persisted as schedule state. */
  onToggleCollapse(taskId: TaskId, collapsed: boolean): void;
}

export interface GanttViewport {
  /** Index of the first rendered row and the count, for virtualization-aware data loading. */
  readonly firstVisibleRow: number;
  readonly visibleRowCount: number;
  readonly rangeStart: string;
  readonly rangeEnd: string;
}

/**
 * What an implementation honestly claims to do. This exists so a stand-in cannot be mistaken for
 * a shippable renderer: the P0 placeholder declares `virtualizedRows: false` and
 * `perfQualified: false`, and the FR-VIEW-02 perf gate refuses to record a baseline from an
 * adapter that is not perf-qualified (ADR-006).
 */
export interface GanttAdapterCapabilities {
  readonly name: string;
  /** FR-VIEW-02: mandatory for the MVP renderer; 2,000 visible rows is not reachable without it. */
  readonly virtualizedRows: boolean;
  readonly dragToMove: boolean;
  readonly dragToResize: boolean;
  readonly drawsDependencyArrows: boolean;
  readonly baselineOverlay: boolean;
  /** False means: not measured against FR-VIEW-02, and not a candidate for MVP. */
  readonly perfQualified: boolean;
}

export interface GanttMountOptions {
  readonly callbacks: GanttAdapterCallbacks;
  readonly initialZoom: GanttZoom;
  /** Row height in CSS pixels; the accessible table mirrors this for scroll synchronisation. */
  readonly rowHeightPx: number;
}

/**
 * The interface `apps/web` codes against. Every method is expressed in ProjectApp terms.
 *
 * Compliance check (ADR-006): on the day the vendor lands, the diff should touch
 * `apps/web/src/gantt/adapter/` and nothing else.
 */
export interface GanttAdapter {
  readonly capabilities: GanttAdapterCapabilities;

  /** Attach to a container. Called once. */
  mount(container: HTMLElement, options: GanttMountOptions): void;

  /** Draw the authoritative model. Idempotent. The only way schedule state enters the renderer. */
  render(model: GanttViewModel): void;

  setZoom(zoom: GanttZoom): void;
  setSelection(taskIds: readonly TaskId[]): void;
  scrollToTask(taskId: TaskId): void;

  /** Release listeners and DOM. Called on unmount; must be safe to call twice. */
  destroy(): void;
}

// --------------------------------------------------------------------------------------------
// Accessible representation (invariant 6, FR-VIEW-03, WCAG 2.1 AA)
// --------------------------------------------------------------------------------------------

/**
 * A canvas Gantt is invisible to a screen reader. The mitigation in the risk register is a
 * synchronized accessible table shipped *alongside* the canvas from P0 — not retrofitted in P8.
 *
 * The row type lives here, next to the view model it is derived from, precisely so the accessible
 * representation is a function of the same authoritative data the canvas draws. Derived from the
 * `GanttViewModel` rather than from the adapter, it survives the vendor swap untouched, and it
 * cannot silently diverge from what sighted users see — if the canvas shows it, this shows it.
 */
export interface AccessibleGanttRow {
  readonly taskId: TaskId;
  /** 1-based, matching `aria-rowindex`. */
  readonly rowIndex: number;
  /** 1-based WBS nesting, matching `aria-level`. */
  readonly level: number;
  readonly wbsCode: string;
  readonly name: string;
  /** Localised, human-readable — a screen reader must not read an ISO timestamp aloud. */
  readonly startLabel: string;
  readonly finishLabel: string;
  readonly durationLabel: string;
  readonly pctCompleteLabel: string;
  /** e.g. "on critical path", "3 days float". Announced, not colour-coded (WCAG 1.4.1). */
  readonly scheduleStatusLabel: string;
  /** Predecessor names in prose, because arrows convey nothing to a screen reader. */
  readonly dependencyLabel: string;
  readonly isCritical: boolean;
  readonly hasScheduleConflict: boolean;
  /** undefined for a leaf row; `aria-expanded` otherwise. */
  readonly isExpanded: boolean | undefined;
}
