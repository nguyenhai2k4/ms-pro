import type {
  ConstraintType,
  CpmDependency,
  CpmScheduleInput,
  CpmTask,
  DependencyType,
  TaskId,
} from '@projectapp/shared-types';
import { at } from '../invariant.js';
import { dependencyId, projectId, taskId } from './fixtures.js';
import { PROJECT_START, standardCalendar, STANDARD_CALENDAR_ID } from './golden/common.js';
import { createSeededRandom } from './random.js';

/**
 * A synthetic-project generator — P2 work item W2-3, built for the suites that come after it.
 *
 * The golden corpus in `./golden/` proves the engine right on cases a human worked out. This proves
 * it *consistent* on cases nobody worked out, at sizes nobody would hand-write: 5,000 tasks for
 * FR-SCH-06's budget, and arbitrarily many random graphs for W5-1's headline property,
 * `recomputeSchedule(...).result === computeSchedule(input)`.
 *
 * Three properties are load-bearing, and each one has a test in `synthetic.test.ts` rather than a
 * promise here:
 *
 *  1. **Acyclic, always.** Every generated graph is safe to schedule. A generator that produced a
 *     cycle once in a thousand runs would turn every property test built on it into a flake that
 *     looks like an engine bug — so `synthetic.test.ts` runs `detectCycle` over the generator's own
 *     output at every size, rather than trusting the argument below.
 *
 *     The argument, for the record: work tasks are assigned a **rank** (a seeded permutation of
 *     0..n-1) and every dependency runs from a lower rank to a higher one. Rank is a total order, so
 *     no sequence of edges can return to its start. Nothing else in this file adds an edge.
 *
 *  2. **Byte-identical for a given seed.** Every random draw comes from one `createSeededRandom`
 *     stream consumed in a fixed order; array positions are assigned by index, never by iteration
 *     over a `Set` or `Map`. No clock, no `Math.random` — this file lives under `src/`, where
 *     `purity.test.ts` scans for exactly that.
 *
 *  3. **Schema-valid.** The output parses against `cpmScheduleInputSchema` unmodified, including
 *     the conditional rules (`manual` requires both manual dates; a dated constraint requires a
 *     `constraintDate`).
 *
 * ## Shape of the graph
 *
 * Ranks are cut into `depth` contiguous layers and **every task in layer L > 0 gets at least one
 * predecessor from layer L - 1**. That makes `topologicalDepth` exactly `depth` rather than
 * approximately it, which matters because `CpmMetrics.topologicalDepth` — not task count — is what
 * the perf suites should correlate runtime against (`topological-order.ts` says why: a 5,000-task
 * chain and a 5,000-task graph three levels deep are very different computations).
 *
 * Because ranks are a *permutation*, edges run from high task ids to low ones about half the time,
 * so the task-id order is not a valid topological order. A generator without that shuffle would let
 * an engine that simply iterated `tasks` in order pass every property test.
 */

/** Every option except `taskCount` and `seed` has a default; see `SYNTHETIC_DEFAULTS`. */
export interface SyntheticProjectOptions {
  /** Total tasks in the result, summary tasks included. 5,000 is FR-SCH-06's budget size. */
  readonly taskCount: number;
  /** Any integer. The same seed and options give a byte-identical `CpmScheduleInput`. */
  readonly seed: number;
  /** Mean in-degree of a task that has predecessors. Clamped to >= 1. */
  readonly avgFanout?: number;
  /** Number of dependency layers, and therefore the graph's exact topological depth. */
  readonly depth?: number;
  /** Fraction of tasks made summary tasks (WBS parents). They carry no dependencies. */
  readonly summaryRatio?: number;
  /** Fraction of work tasks given `scheduleMode: 'manual'` and fixed dates (FR-TSK-05). */
  readonly manualRatio?: number;
  /** Fraction of work tasks given a dated constraint (FR-TSK-06). */
  readonly constrainedRatio?: number;
  /** Fraction of work tasks made zero-duration milestones (FR-TSK-04). */
  readonly milestoneRatio?: number;
}

/**
 * Defaults are the *plainest* graph that is still interesting: all leaves, all auto, all ASAP. The
 * three ratios default to 0 so a caller that wants manual tasks or constraints in its property runs
 * has to ask for them, and so the base case cannot quietly acquire a feature later.
 */
export const SYNTHETIC_DEFAULTS = Object.freeze({
  avgFanout: 2,
  depth: 12,
  summaryRatio: 0,
  manualRatio: 0,
  constrainedRatio: 0,
  milestoneRatio: 0,
});

/**
 * Dependency types drawn per edge. FS-weighted because real schedules are, and because a corpus of
 * uniformly-distributed SF links would exercise the rarest path more than the common one.
 */
const DEPENDENCY_TYPES: readonly DependencyType[] = ['FS', 'FS', 'FS', 'FS', 'SS', 'FF', 'SF'];

/** Signed working hours (FR-SCH-02). Zero-weighted, with one lead so leads are always exercised. */
const LAG_HOURS: readonly number[] = [0, 0, 0, 0, 4, 8, 16, -4];

/**
 * Constraint dates are drawn from a literal pool rather than computed.
 *
 * This file may not construct a `Date` — it lives under `src/`, and `purity.test.ts` scans for it —
 * and hand-rolling civil-date arithmetic here would put a second, untested calendar implementation
 * inside the test support for the engine whose calendar is the thing under test. A fixed pool of
 * instants spanning the generated project's plausible span is enough for what these are for:
 * exercising the constraint code paths, not asserting a particular date.
 */
const CONSTRAINT_DATES: readonly string[] = [
  '2026-09-07T08:00:00.000Z',
  '2026-09-11T16:00:00.000Z',
  '2026-09-18T12:00:00.000Z',
  '2026-09-25T08:00:00.000Z',
  '2026-10-02T16:00:00.000Z',
  '2026-10-09T12:00:00.000Z',
  '2026-10-16T08:00:00.000Z',
  '2026-10-23T16:00:00.000Z',
  '2026-11-06T12:00:00.000Z',
  '2026-11-20T08:00:00.000Z',
  '2026-12-04T16:00:00.000Z',
  '2026-12-18T12:00:00.000Z',
];

/** Constraint types that require a `constraintDate`. ASAP/ALAP are applied without one. */
const DATED_CONSTRAINTS: readonly ConstraintType[] = ['SNET', 'SNLT', 'FNET', 'FNLT', 'MSO', 'MFO'];

/** `[manualStart, manualFinish]` pairs, same reasoning as `CONSTRAINT_DATES`. */
const MANUAL_DATE_PAIRS: readonly (readonly [string, string])[] = [
  ['2026-09-07T08:00:00.000Z', '2026-09-08T16:00:00.000Z'],
  ['2026-09-14T08:00:00.000Z', '2026-09-16T12:00:00.000Z'],
  ['2026-09-21T12:00:00.000Z', '2026-09-25T16:00:00.000Z'],
  ['2026-10-05T08:00:00.000Z', '2026-10-06T16:00:00.000Z'],
  ['2026-10-19T08:00:00.000Z', '2026-10-23T12:00:00.000Z'],
  ['2026-11-09T12:00:00.000Z', '2026-11-13T16:00:00.000Z'],
];

/** The project id every synthetic project carries. Distinct from the golden corpus's. */
export const SYNTHETIC_PROJECT_ID = projectId(2);

/**
 * Builds a valid, acyclic `CpmScheduleInput`. Pure: the same options give the same bytes, on every
 * machine, forever.
 *
 * Throws `RangeError` on options that cannot describe a graph (a non-positive `taskCount`, a
 * non-integer count, a ratio outside 0..1). These are caller bugs in a test, not user input, so
 * throwing is right here in a way it never is inside the engine itself — see `invariant.ts`.
 */
export function makeSyntheticProject(options: SyntheticProjectOptions): CpmScheduleInput {
  const taskCount = requirePositiveInteger(options.taskCount, 'taskCount');
  const avgFanout = Math.max(1, options.avgFanout ?? SYNTHETIC_DEFAULTS.avgFanout);
  const summaryRatio = requireRatio(options.summaryRatio ?? SYNTHETIC_DEFAULTS.summaryRatio);
  const manualRatio = requireRatio(options.manualRatio ?? SYNTHETIC_DEFAULTS.manualRatio);
  const constrainedRatio = requireRatio(
    options.constrainedRatio ?? SYNTHETIC_DEFAULTS.constrainedRatio,
  );
  const milestoneRatio = requireRatio(options.milestoneRatio ?? SYNTHETIC_DEFAULTS.milestoneRatio);

  const next = createSeededRandom(options.seed);

  // ---- Split the id space: [1 .. summaryCount] are summaries, the rest are work tasks. ---------
  // At least one work task always remains, or there would be no graph to schedule.
  const summaryCount = Math.min(Math.floor(taskCount * summaryRatio), taskCount - 1);
  const workCount = taskCount - summaryCount;
  const layers = Math.max(1, Math.min(options.depth ?? SYNTHETIC_DEFAULTS.depth, workCount));

  // ---- Ranks: a seeded permutation of the work tasks. See property 1 in the file docstring. ----
  // Fisher-Yates, written out rather than reusing `shuffled` so the identity mapping is explicit:
  // `rankOfWork[k]` is the *work-task index* (0-based) sitting at rank k.
  const rankOfWork: number[] = Array.from({ length: workCount }, (_, i) => i);
  for (let i = workCount - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = at(rankOfWork, i);
    rankOfWork[i] = at(rankOfWork, j);
    rankOfWork[j] = a;
  }

  // ---- Layer boundaries. Contiguous half-open rank ranges, `layers` of them. -------------------
  const layerStart: number[] = [];
  for (let layer = 0; layer <= layers; layer += 1) {
    layerStart.push(Math.floor((layer * workCount) / layers));
  }

  // ---- Tasks. ----------------------------------------------------------------------------------
  const tasks: CpmTask[] = [];

  for (let s = 1; s <= summaryCount; s += 1) {
    // A summary's parent is always a *lower-numbered* summary, so the WBS forest is acyclic by the
    // same argument the dependency graph uses. The first summary is always a root.
    const isRoot = next() < 0.25;
    const parentDraw = next();
    const parentId = s === 1 || isRoot ? null : taskId(1 + Math.floor(parentDraw * (s - 1)));
    tasks.push(summaryTask(s, parentId));
  }

  for (let rank = 0; rank < workCount; rank += 1) {
    const n = summaryCount + at(rankOfWork, rank) + 1;
    const parentId = summaryCount === 0 ? null : taskId(1 + Math.floor(next() * summaryCount));
    const isMilestone = next() < milestoneRatio;
    const durationHours = isMilestone ? 0 : 1 + Math.floor(next() * 16);
    const manual = next() < manualRatio;
    const constrained = next() < constrainedRatio;

    const manualPair = manual ? pick(MANUAL_DATE_PAIRS, next()) : null;
    const constraintType = constrained ? pick(DATED_CONSTRAINTS, next()) : 'ASAP';
    const constraintDate = constrained ? pick(CONSTRAINT_DATES, next()) : null;

    tasks.push({
      id: taskId(n),
      parentId,
      durationHours,
      isMilestone,
      scheduleMode: manual ? 'manual' : 'auto',
      constraintType,
      constraintDate,
      calendarId: null,
      manualStart: manualPair === null ? null : manualPair[0],
      manualFinish: manualPair === null ? null : manualPair[1],
    });
  }

  // `tasks` is emitted in rank order for the work tasks, which is a shuffle of id order. Sorting it
  // would be free determinism, and would also hide an engine that depends on input order — so it is
  // left shuffled on purpose. `buildGraph` canonicalises, and `determinism.test.ts` is the proof.

  // ---- Dependencies. Every edge runs from a strictly lower rank to a higher one. ----------------
  const dependencies: CpmDependency[] = [];
  // Mean in-degree `avgFanout` from a uniform draw over 1..(2 * avgFanout - 1).
  const fanoutSpread = Math.max(1, Math.round(2 * avgFanout - 1));

  for (let layer = 1; layer < layers; layer += 1) {
    const sourceFrom = at(layerStart, layer - 1);
    const sourceCount = at(layerStart, layer) - sourceFrom;

    for (let rank = at(layerStart, layer); rank < at(layerStart, layer + 1); rank += 1) {
      const successorId = workTaskId(summaryCount, rankOfWork, rank);
      const wanted = 1 + Math.floor(next() * fanoutSpread);
      const chosen = new Set<TaskId>();

      for (let attempt = 0; attempt < wanted; attempt += 1) {
        const predecessorId = workTaskId(
          summaryCount,
          rankOfWork,
          sourceFrom + Math.floor(next() * sourceCount),
        );
        // A repeat draw is dropped rather than retried: retrying would make the number of `next()`
        // calls depend on the draws themselves, which is still deterministic but far harder to
        // reason about when a future change alters the pool size.
        if (chosen.has(predecessorId)) continue;
        chosen.add(predecessorId);

        dependencies.push({
          id: dependencyId(dependencies.length + 1),
          predecessorId,
          successorId,
          type: pick(DEPENDENCY_TYPES, next()),
          lagHours: pick(LAG_HOURS, next()),
        });
      }
    }
  }

  return {
    projectId: SYNTHETIC_PROJECT_ID,
    projectStart: PROJECT_START,
    direction: 'forward',
    defaultCalendarId: STANDARD_CALENDAR_ID,
    calendars: [standardCalendar()],
    tasks,
    dependencies,
  };
}

function summaryTask(n: number, parentId: TaskId | null): CpmTask {
  return {
    id: taskId(n),
    parentId,
    // Ignored for a summary (cpm.ts: "derived from its children"); 0 so nothing can read it as one.
    durationHours: 0,
    isMilestone: false,
    scheduleMode: 'auto',
    constraintType: 'ASAP',
    constraintDate: null,
    calendarId: null,
    manualStart: null,
    manualFinish: null,
  };
}

/** The task id at a given rank. Work tasks occupy ids `summaryCount + 1 .. taskCount`. */
function workTaskId(summaryCount: number, rankOfWork: readonly number[], rank: number): TaskId {
  return taskId(summaryCount + at(rankOfWork, rank) + 1);
}

/** Uniform pick from a non-empty pool, given a draw in [0, 1). */
function pick<T>(pool: readonly T[], draw: number): T {
  return at(pool, Math.floor(draw * pool.length));
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`makeSyntheticProject: ${name} must be a positive integer, got ${value}`);
  }
  return value;
}

function requireRatio(value: number): number {
  if (!(value >= 0 && value <= 1)) {
    throw new RangeError(`makeSyntheticProject: ratios must be within 0..1, got ${value}`);
  }
  return value;
}
