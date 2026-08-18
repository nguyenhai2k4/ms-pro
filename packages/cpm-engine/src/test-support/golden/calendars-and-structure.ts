import type { CpmCalendar } from '@projectapp/shared-types';
import { dependencyId, makeDependency, makeTask, taskId } from '../fixtures.js';
import type { GoldenFixture } from './common.js';
import {
  EXCEPTION_CALENDAR_ID,
  metrics,
  rejected,
  scheduled,
  scheduleInput,
  taskSchedule,
} from './common.js';

/**
 * Golden fixtures F16-F19 — calendar exceptions inside a task's span (FR-SCH-07, FR-CAL-02), a
 * four-level WBS rollup (FR-TSK-02/03), a milestone chain (FR-TSK-04), and the cycle rejection that
 * must leave no partial state (FR-SCH-03).
 *
 * F17-F19 use the standard calendar and the shared `wh` day table in `common.ts`. F16 brings its
 * own calendar, and re-derives its ladder from scratch because that is the whole point of it.
 */

// =============================================================================================
// F16 — a holiday and a half-day, both falling inside a task's span
// =============================================================================================
/**
 * FR-SCH-07 is the requirement most likely to be "tested" against a fixture that never crosses a
 * non-working day, which proves nothing. This one puts **two** exceptions strictly inside t1's span
 * and then shows the displacement arriving at t2 — the downstream effect is the part that matters,
 * because a calendar bug that only moved the task carrying the exception would be caught by a unit
 * test on the calendar kernel; one that fails to propagate would not.
 *
 * Calendar (`EXCEPTION_CALENDAR_ID`, the project default here): Mon-Fri 08:00-16:00 UTC, plus
 * ```
 *   2026-09-09 (Wed)  isWorking: false                       -> a holiday, 0 working hours
 *   2026-09-10 (Thu)  isWorking: true,  08:00-12:00 (480-720) -> a half-day, 4 working hours
 * ```
 * Working-hour ladder from the project start (Mon 2026-09-07 08:00Z) — note the two irregular rungs:
 * ```
 *   Mon 2026-09-07   8h    wh  0 ..  8
 *   Tue 2026-09-08   8h    wh  8 .. 16
 *   Wed 2026-09-09   0h    --------------  holiday
 *   Thu 2026-09-10   4h    wh 16 .. 20     half-day, 08:00-12:00
 *   Fri 2026-09-11   8h    wh 20 .. 28
 *   Mon 2026-09-14   8h    wh 28 .. 36
 * ```
 * Graph: `t1(24h) -FS+0-> t2(8h)`.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES =  0                EF =  0 + 24 = 24     -> 24 sits in Friday's rung [20, 28) at
 *                                                       offset 4, i.e. Fri 2026-09-11 12:00Z
 *   t2  ES = t1.EF = 24        EF = 24 +  8 = 32     -> 32 sits in Monday's rung [28, 36) at
 *                                                       offset 4, i.e. Mon 2026-09-14 12:00Z
 *   projectFinish = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t2  no successor     LF = 32                     LS = 32 - 8  = 24
 *   t1  FS to t2         LF = t2.LS = 24             LS = 24 - 24 =  0
 * ```
 * Float: both `0`. Both critical, the edge is driving, so it is critical.
 *
 * The number to check by eye: t1 is a 24-working-hour task that spans **five** calendar days
 * (Mon-Fri) rather than three, because 12 of those hours are unavailable — 8 to the holiday and 4
 * to the half-day. An implementation that counted the half-day as a whole day finishes t1 at Fri
 * 08:00 and t2 at Mon 08:00; one that ignored the holiday finishes t1 at Wed 16:00.
 *
 * Every instant here lands at 12:00, mid-rung, so none of it depends on the day-boundary
 * normalisation rule (see `common.ts`). That is deliberate: this fixture tests the calendar, not
 * the boundary convention.
 */
const exceptionCalendar: CpmCalendar = {
  id: EXCEPTION_CALENDAR_ID,
  workingDays: [1, 2, 3, 4, 5],
  workingHoursStartMinute: 480, // 08:00 UTC (ADR-011)
  workingHoursEndMinute: 960, // 16:00 UTC
  exceptions: [
    {
      date: '2026-09-09', // Wednesday — holiday
      isWorking: false,
      startMinuteOverride: null,
      endMinuteOverride: null,
    },
    {
      date: '2026-09-10', // Thursday — half-day, 08:00-12:00
      isWorking: true,
      startMinuteOverride: 480,
      endMinuteOverride: 720,
    },
  ],
};

export const F16_CALENDAR_EXCEPTION_MID_TASK: GoldenFixture = {
  id: 'F16-calendar-exception-mid-task',
  proves:
    'A holiday and a half-day falling inside a task’s span stretch it across the non-working time, and the displacement propagates to its FS successor.',
  requirements: ['FR-SCH-07', 'FR-CAL-01', 'FR-CAL-02', 'FR-TSK-07'],
  input: scheduleInput({
    calendars: [exceptionCalendar],
    defaultCalendarId: EXCEPTION_CALENDAR_ID,
    tasks: [makeTask(1, { durationHours: 24 }), makeTask(2, { durationHours: 8 })],
    dependencies: [makeDependency(1, 1, 2)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-11T12:00:00.000Z', // wh 24 — Friday, after the holiday and the half-day
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-11T12:00:00.000Z',
        floatHours: 0,
        durationHours: 24,
      }),
      taskSchedule(2, {
        es: '2026-09-11T12:00:00.000Z', // wh 24
        ef: '2026-09-14T12:00:00.000Z', // wh 32
        ls: '2026-09-11T12:00:00.000Z',
        lf: '2026-09-14T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(1)],
    projectFinish: '2026-09-14T12:00:00.000Z',
    metrics: metrics({ tasks: 2, edges: 1, depth: 2 }),
  }),
};

// =============================================================================================
// F17 — four levels of WBS rollup
// =============================================================================================
/**
 * FR-TSK-02's "arbitrary-depth hierarchy" plus FR-TSK-03's rollup, at the depth where a
 * one-level-only implementation stops working. Three nested summaries, each with a leaf of its own,
 * so every level has to combine a rolled-up child with a directly-scheduled one:
 *
 * ```
 *   t1 GP  summary ---- t2 P   summary ---- t3 C   summary ---- t4 GC1  leaf 16h
 *                 |                   |                   |---- t5 GC2  leaf  8h
 *                 |                   |---- t7 B   leaf 24h
 *                 |---- t6 A   leaf  8h
 *   edges:  d1 A -> GC1 (FS),  d2 GC1 -> B (FS)      (leaves only)
 * ```
 * Leaf forward pass (wh):
 * ```
 *   t6 A    ES = 0                    EF =  0 +  8 =  8
 *   t4 GC1  ES = t6.EF = 8            EF =  8 + 16 = 24
 *   t5 GC2  no predecessor, ES = 0    EF =  0 +  8 =  8
 *   t7 B    ES = t4.EF = 24           EF = 24 + 24 = 48
 *   projectFinish = max(EF) = 48
 * ```
 * Leaf backward pass (wh):
 * ```
 *   t7 B    no successor    LF = 48              LS = 48 - 24 = 24     float 24 - 24 =  0
 *   t4 GC1  FS to t7        LF = t7.LS = 24      LS = 24 - 16 =  8     float  8 -  8 =  0
 *   t5 GC2  no successor    LF = 48              LS = 48 -  8 = 40     float 40 -  0 = 40
 *   t6 A    FS to t4        LF = t4.LS =  8      LS =  8 -  8 =  0     float  0 -  0 =  0
 * ```
 * Rollup, innermost first, by the ESC-2 rule (`common.ts`, "Summary tasks: rollup and late dates"):
 * `ES = min(child ES)`, `EF = max(child EF)` per FR-TSK-03; `float = min(child float)`;
 * `LS = ES + float` and `LF = EF + float` in working time; start/finish = min/max of the children's
 * dates; duration = the working-hour span (FR-SCH-07). Each level consumes only its **direct**
 * children — including children that are themselves summaries, whose float was computed one line
 * earlier:
 * ```
 *   t3 C  over {GC1, GC2}:  ES  = min( 8,  0) =  0        EF = max(24,  8) = 24
 *                           float = min(0, 40) = 0        <- from GC1; GC2's 40 never binds
 *                           LS  =  0 + 0 =  0             LF = 24 + 0 = 24
 *                           span wh 0 -> 24  ->  durationHours 24
 *   t2 P  over {C, B}:      ES  = min( 0, 24) =  0        EF = max(24, 48) = 48
 *                           float = min(C 0, B 0) = 0     <- C's float, just derived above
 *                           LS  =  0 + 0 =  0             LF = 48 + 0 = 48
 *                           span wh 0 -> 48  ->  durationHours 48
 *   t1 GP over {P, A}:      ES  = min( 0,  0) =  0        EF = max(48,  8) = 48
 *                           float = min(P 0, A 0) = 0
 *                           LS  =  0 + 0 =  0             LF = 48 + 0 = 48
 *                           span wh 0 -> 48  ->  durationHours 48
 * ```
 * The level-by-level check: rolling P up from {C, B} gives the same answer as rolling it up from
 * all four of its descendant leaves, because min and max are associative — and that now covers the
 * late side too, since `min(child float)` is a min like the others. An implementation that only
 * looks at direct children and one that flattens to leaves must therefore agree — if they do not,
 * one of them is dropping a level, and t2's `earlyStart` of wh 0 (which it can only get through C,
 * from GC2) is the value that catches it.
 *
 * All three summaries come out critical, each because the chain A -> GC1 -> B runs through it: C
 * contains GC1, P contains C and B, GP contains all of them. That is the corrected rule doing what
 * it was corrected for — under the corpus's original `LS = min(child LS)` / `LF = max(child LF)`,
 * C and P reported float 8 and were drawn as non-critical bars spanning critical children, which is
 * a hole in the FR-SCH-10 highlight. GC2 keeps its float 40 and stays non-critical; criticality
 * propagates *up* a WBS tree, never *down* it.
 */
export const F17_FOUR_LEVEL_WBS: GoldenFixture = {
  id: 'F17-four-level-wbs-rollup',
  proves:
    'Rollup composes through grandparent -> parent -> child -> grandchild, mixing a rolled-up child with a directly-scheduled leaf at every level, and float reaches every summary spanning the critical chain.',
  requirements: ['FR-TSK-02', 'FR-TSK-03', 'FR-SCH-05', 'FR-SCH-07'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 0 }), // GP  — summary, duration derived
      makeTask(2, { parentId: taskId(1), durationHours: 0 }), // P   — summary
      makeTask(3, { parentId: taskId(2), durationHours: 0 }), // C   — summary
      makeTask(4, { parentId: taskId(3), durationHours: 16 }), // GC1 — leaf
      makeTask(5, { parentId: taskId(3), durationHours: 8 }), // GC2 — leaf
      makeTask(6, { parentId: taskId(1), durationHours: 8 }), // A   — leaf
      makeTask(7, { parentId: taskId(2), durationHours: 24 }), // B   — leaf
    ],
    dependencies: [makeDependency(1, 6, 4), makeDependency(2, 4, 7)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        // GP — float = min(P 0, A 0) = 0
        es: '2026-09-07T08:00:00.000Z', // wh 0  = min(child ES)
        ef: '2026-09-14T16:00:00.000Z', // wh 48 = max(child EF)
        ls: '2026-09-07T08:00:00.000Z', // wh 0  = ES + 0
        lf: '2026-09-14T16:00:00.000Z', // wh 48 = EF + 0
        floatHours: 0,
        durationHours: 48,
      }),
      taskSchedule(2, {
        // P — float = min(C 0, B 0) = 0
        es: '2026-09-07T08:00:00.000Z', // wh 0  = min(child ES)
        ef: '2026-09-14T16:00:00.000Z', // wh 48 = max(child EF)
        ls: '2026-09-07T08:00:00.000Z', // wh 0  = ES + 0
        lf: '2026-09-14T16:00:00.000Z', // wh 48 = EF + 0
        floatHours: 0,
        durationHours: 48,
      }),
      taskSchedule(3, {
        // C — float = min(GC1 0, GC2 40) = 0
        es: '2026-09-07T08:00:00.000Z', // wh 0  = min(child ES)
        ef: '2026-09-09T16:00:00.000Z', // wh 24 = max(child EF)
        ls: '2026-09-07T08:00:00.000Z', // wh 0  = ES + 0
        lf: '2026-09-09T16:00:00.000Z', // wh 24 = EF + 0
        floatHours: 0,
        durationHours: 24,
      }),
      taskSchedule(4, {
        // GC1
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-08T08:00:00.000Z',
        lf: '2026-09-09T16:00:00.000Z',
        floatHours: 0,
        durationHours: 16,
      }),
      taskSchedule(5, {
        // GC2
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-14T08:00:00.000Z', // wh 40
        lf: '2026-09-14T16:00:00.000Z', // wh 48
        floatHours: 40,
        durationHours: 8,
      }),
      taskSchedule(6, {
        // A
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-07T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(7, {
        // B
        es: '2026-09-10T08:00:00.000Z', // wh 24
        ef: '2026-09-14T16:00:00.000Z', // wh 48
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-14T16:00:00.000Z',
        floatHours: 0,
        durationHours: 24,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(2)],
    projectFinish: '2026-09-14T16:00:00.000Z',
    metrics: metrics({ tasks: 7, edges: 2, depth: 3 }),
  }),
};

// =============================================================================================
// F18 — a milestone chain
// =============================================================================================
/**
 * FR-TSK-04: a milestone has duration 0 and finish === start. The failure this fixture exists to
 * catch is a zero-duration task that quietly acquires a day, an hour or a working-minute of span —
 * usually from an implementation that advances to "the next working minute" after placing a task
 * regardless of whether any time was consumed. Three milestones in a row make that error
 * accumulate, so it shows up as a wrong project finish rather than a rounding curiosity.
 *
 * ```
 *   t1 M1 (0h) -> t2 T1 (4h) -> t3 M2 (0h) -> t4 T2 (3h) -> t5 M3 (0h)     all FS, all lag 0
 * ```
 * Every task fits inside the project's first working day (Mon 2026-09-07, 08:00-16:00 = wh 0..8),
 * which is deliberate: it keeps t3 and t5 at **interior** working hours, and puts t1 at `wh 0`,
 * where `common.ts`'s never-cross-`projectStart` floor makes the answer unique. So no milestone here
 * lands on an interior day boundary, and ESC-3 — which side of such a boundary a zero-duration task
 * sits on — is avoided rather than guessed at.
 *
 * Forward pass (wh):
 * ```
 *   t1 M1  ES = 0            EF = 0 + 0 = 0
 *   t2 T1  ES = 0            EF = 0 + 4 = 4
 *   t3 M2  ES = 4            EF = 4 + 0 = 4
 *   t4 T2  ES = 4            EF = 4 + 3 = 7
 *   t5 M3  ES = 7            EF = 7 + 0 = 7
 *   projectFinish = 7        (NOT 8, 9 or 10 — see above)
 * ```
 * Backward pass (wh):
 * ```
 *   t5 M3  LF = 7   LS = 7 - 0 = 7        t4 T2  LF = 7   LS = 7 - 3 = 4
 *   t3 M2  LF = 4   LS = 4 - 0 = 4        t2 T1  LF = 4   LS = 4 - 4 = 0
 *   t1 M1  LF = 0   LS = 0 - 0 = 0
 * ```
 * Float: all `0`. A single unbroken chain, so all four edges are critical.
 *
 * Dates within Monday: wh 0 -> 08:00, wh 4 -> 12:00, wh 7 -> 15:00.
 */
export const F18_MILESTONE_CHAIN: GoldenFixture = {
  id: 'F18-milestone-chain',
  proves:
    'Zero-duration tasks have finish === start and accumulate no span: three chained milestones leave the project finish at wh 7, not later.',
  requirements: ['FR-TSK-04', 'FR-SCH-01', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 0, isMilestone: true }),
      makeTask(2, { durationHours: 4 }),
      makeTask(3, { durationHours: 0, isMilestone: true }),
      makeTask(4, { durationHours: 3 }),
      makeTask(5, { durationHours: 0, isMilestone: true }),
    ],
    dependencies: [
      makeDependency(1, 1, 2),
      makeDependency(2, 2, 3),
      makeDependency(3, 3, 4),
      makeDependency(4, 4, 5),
    ],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T08:00:00.000Z', // wh 0 — finish === start
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-07T08:00:00.000Z',
        floatHours: 0,
        durationHours: 0,
      }),
      taskSchedule(2, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T12:00:00.000Z', // wh 4
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-07T12:00:00.000Z',
        floatHours: 0,
        durationHours: 4,
      }),
      taskSchedule(3, {
        es: '2026-09-07T12:00:00.000Z', // wh 4
        ef: '2026-09-07T12:00:00.000Z', // wh 4
        ls: '2026-09-07T12:00:00.000Z',
        lf: '2026-09-07T12:00:00.000Z',
        floatHours: 0,
        durationHours: 0,
      }),
      taskSchedule(4, {
        es: '2026-09-07T12:00:00.000Z', // wh 4
        ef: '2026-09-07T15:00:00.000Z', // wh 7
        ls: '2026-09-07T12:00:00.000Z',
        lf: '2026-09-07T15:00:00.000Z',
        floatHours: 0,
        durationHours: 3,
      }),
      taskSchedule(5, {
        es: '2026-09-07T15:00:00.000Z', // wh 7
        ef: '2026-09-07T15:00:00.000Z', // wh 7
        ls: '2026-09-07T15:00:00.000Z',
        lf: '2026-09-07T15:00:00.000Z',
        floatHours: 0,
        durationHours: 0,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(2), dependencyId(3), dependencyId(4)],
    projectFinish: '2026-09-07T15:00:00.000Z',
    metrics: metrics({ tasks: 5, edges: 4, depth: 5 }),
  }),
};

// =============================================================================================
// F19 — a cycle, rejected whole
// =============================================================================================
/**
 * FR-SCH-03 and ADR-010 §7: a cycle rejects the **whole** computation. `cpmRejectedResultSchema` has
 * no `taskSchedules` field at all, so "no partial state" is structural — this fixture's job is to
 * pin the *diagnostic*, which is the part a caller renders.
 *
 * ```
 *   t1 -d1-> t2 -d2-> t3 -d3-> t4 -d4-> t2        and     t4 -d5-> t5
 * ```
 * Hand trace. t1 has no predecessor, so any walk starts there and reaches t2 by d1. From t2, d2
 * reaches t3; from t3, d3 reaches t4; from t4, d4 reaches t2 — already on the current path, so the
 * loop is `t2 -> t3 -> t4 -> t2`, carried by `d2, d3, d4`. t1 and t5 are outside it: t1 has no
 * incoming edge and t5 has no outgoing one, so neither can lie on a loop. d1 and d5 are therefore
 * not part of the answer, which is the "identify *the cycle*, not everything downstream of it"
 * requirement in FR-SCH-03.
 *
 * `cyclePath` starts at t2 because `cycle.ts` rotates every reported loop to begin at its lowest
 * `taskId` (so the same loop is named identically no matter where the search entered it), and
 * repeats the entry task at the end: `[t2, t3, t4, t2]`. `cycleDependencyIds` is the edge list in
 * the same order — `cyclePath[i] --cycleDependencyIds[i]--> cyclePath[i+1]` — giving `[d2, d3, d4]`.
 *
 * **This is the one fixture whose expectation can be cross-checked against running code**, because
 * `detectCycle` is W1-1 and already exists. `golden-corpus.test.ts` does exactly that. The hand
 * trace above is still the primary artefact: it says *why* the loop is a loop, which a passing
 * assertion does not.
 */
export const F19_CYCLE_REJECTED: GoldenFixture = {
  id: 'F19-cycle-rejected',
  proves:
    'A dependency cycle rejects the whole computation and names exactly the loop — t2/t3/t4 — not the acyclic tasks hanging off it.',
  requirements: ['FR-SCH-03'],
  input: scheduleInput({
    tasks: [makeTask(1), makeTask(2), makeTask(3), makeTask(4), makeTask(5)],
    dependencies: [
      makeDependency(1, 1, 2),
      makeDependency(2, 2, 3),
      makeDependency(3, 3, 4),
      makeDependency(4, 4, 2),
      makeDependency(5, 4, 5),
    ],
  }),
  expected: rejected([
    {
      code: 'dependency_cycle',
      severity: 'error',
      cyclePath: [taskId(2), taskId(3), taskId(4), taskId(2)],
      cycleDependencyIds: [dependencyId(2), dependencyId(3), dependencyId(4)],
    },
  ]),
};
