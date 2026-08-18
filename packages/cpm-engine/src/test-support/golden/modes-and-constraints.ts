import { dependencyId, makeDependency, makeTask, taskId } from '../fixtures.js';
import type { GoldenFixture } from './common.js';
import { metrics, scheduled, scheduleInput, taskSchedule } from './common.js';

/**
 * Golden fixtures F07-F15 and F20 — scheduling mode (FR-TSK-05), summary rollup inside a mixed
 * subtree (FR-TSK-03), the manual-conflict flag (FR-SCH-08), one fixture per constraint type
 * (FR-TSK-06), and what a manual task hands to its successors (F20, ESC-6).
 *
 * Same working-time frame as F01-F06: Mon-Fri 08:00-16:00 UTC, project start Monday
 * 2026-09-07T08:00Z, derivations in working hours since the project start (`wh`). `common.ts`
 * carries the `wh` -> date table.
 *
 * # Constraint semantics this corpus encodes (FR-TSK-06)
 *
 * The FRS names the eight types but does not spell out their arithmetic, so it is written out here
 * once and each fixture then only has to show its own numbers. `C` is `constraintDate` in `wh`:
 *
 * ```
 *   ASAP   no effect. ES from the predecessors, LS from the successors. (F01-F06, and every
 *          unconstrained task below.)
 *   ALAP   no effect on ES/EF; the persisted start/finish become LS/LF. See ESC-5.          (F15)
 *   MSO    hard pin on the start, both directions: ES = LS = C. Absorbs all of the task's float,
 *          so an MSO task always reports float 0 and pushes slack onto its predecessors. (F09)
 *   MFO    hard pin on the finish, both directions: EF = LF = C, ES = LS = C - duration.   (F10)
 *   SNET   floor on the start:   ES = max(predecessor-implied ES, C).                      (F11)
 *   SNLT   ceiling on the start: LS = min(successor-implied LS, C). Cannot move ES, so when the
 *          predecessors already push ES past C the float goes negative and the task is flagged
 *          with a `constraint_violation` warning — the engine still schedules.             (F12)
 *   FNET   floor on the finish:  EF = max(predecessor-implied EF, C), then ES = EF - duration.
 *          A floor, not a pin: a task already finishing later is not pulled back.          (F13)
 *   FNLT   ceiling on the finish: LF = min(successor-implied LF, C).                       (F14)
 * ```
 *
 * MSO/MFO/SNLT/FNLT are the four that can be *violated*; `cpm.ts` specifies the response — schedule
 * anyway, let float go negative, emit a `constraint_violation` **warning** and set
 * `hasScheduleConflict`. F12 is the corpus's violated case, and its negative-float tasks are
 * **critical**: FR-SCH-05 reads `Float <= 0` since docs/FRS.md v1.2 (ESC-4).
 */

// =============================================================================================
// F07 — a mixed manual/auto subtree that rolls up
// =============================================================================================
/**
 * FR-TSK-03 rollup moves into this engine in P2 (ADR-010), and FR-TSK-05 says a manual task "does
 * not move; it still rolls up and can still be critical". This fixture proves all three parts at
 * once: the summary derives its dates from both children, the manual child sits at its fixed dates,
 * and the manual child comes out **on** the critical path while its auto sibling does not.
 *
 * ```
 *   t1  P   summary, children t2 and t4                    (input durationHours ignored)
 *   t2  M   manual,  fixed 2026-09-08T08:00Z .. 2026-09-09T16:00Z   = wh  8 .. 24, 16h
 *   t3  U   auto,    8h                                                    parent t1
 *   t4  X   auto,    8h, top level
 *   t5  Z   auto,    8h, top level
 *   edges:  d1 X->M (FS), d2 X->U (FS), d3 M->Z (FS)
 * ```
 * Careful: the parent of t2 and t3 is t1; t4 and t5 are top level. Dependencies only ever touch
 * leaves — a dependency on a summary task is a separate question the corpus does not answer.
 *
 * **The manual dates were chosen to coincide exactly with the graph-implied dates**, so t5's start
 * is the same instant whether a successor of a manual task schedules from the manual finish or from
 * the graph-implied early finish. That was originally to avoid pre-empting ESC-6; the ruling has
 * since gone to the manual finish, and **F20** is the fixture that discriminates the two. This one
 * keeps its coinciding dates on purpose: it is about the rollup and about a manual task landing on
 * the critical path, and it should stay insensitive to the successor rule so that a failure here
 * localises to the rollup.
 *
 * Forward pass (wh):
 * ```
 *   t4 X  ES = 0                             EF = 0 + 8   =  8
 *   t2 M  graph-implied ES = t4.EF = 8       EF = 8 + 16  = 24   (== the fixed dates: no conflict)
 *   t3 U  ES = t4.EF = 8                     EF = 8 + 8   = 16
 *   t5 Z  ES = 24                            EF = 24 + 8  = 32
 *   t1 P  rollup: ES = min(8, 8) = 8         EF = max(24, 16) = 24
 *   projectFinish = max(EF) = max(8, 24, 16, 32, 24) = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t5 Z  no successor      LF = 32                       LS = 32 - 8  = 24
 *   t2 M  FS to t5          LF = t5.LS = 24               LS = 24 - 16 =  8
 *   t3 U  no successor      LF = 32                       LS = 32 - 8  = 24
 *   t4 X  LF = min(t2.LS, t3.LS) = min(8, 24) = 8         LS =  8 - 8  =  0
 * ```
 * Float = LS - ES on the leaves: X `0-0=0`, M `8-8=0` (**critical, and manual** — FR-TSK-05),
 * U `24-8=16`, Z `24-24=0`.
 *
 * Summary t1 P, over its direct children t2 M (float 0) and t3 U (float 16), by the ESC-2 rule
 * (`common.ts`, "Summary tasks: rollup and late dates"):
 * ```
 *   ES = min(child ES) = min( 8,  8) =  8        EF = max(child EF) = max(24, 16) = 24
 *   float = min(child float) = min(0, 16) = 0
 *   LS = ES + float =  8 + 0 =  8                LF = EF + float = 24 + 0 = 24
 * ```
 * So P inherits float 0 from its critical manual child and is itself critical — which is the whole
 * reason the corpus's first rule (`LS = min(child LS)`, `LF = max(child LF)`) was overruled. Under
 * it, P's LF was wh **32**: 8 working hours later than its own early finish while reporting float 0,
 * so `LF - EF` and `totalFloatHours` disagreed on the same row. Here they agree, and they agree
 * exactly: `LF - EF = LS - ES = float = 0`.
 *
 * Rolled-up values for t1: start = min(child start) = wh 8, finish = max(child finish) = wh 24,
 * durationHours = the working-hour span wh 8 -> wh 24 = **16** (FR-SCH-07: working hours, not the
 * wall-clock span, which would have been 32).
 */
export const F07_MIXED_MANUAL_AUTO_SUBTREE: GoldenFixture = {
  id: 'F07-mixed-manual-auto-subtree',
  proves:
    'A summary rolls up start/finish/duration across a manual child and an auto child, and the manual child can be on the critical path while the auto sibling has float.',
  requirements: ['FR-TSK-02', 'FR-TSK-03', 'FR-TSK-05', 'FR-SCH-05', 'FR-SCH-07'],
  input: scheduleInput({
    tasks: [
      // Summary. Its input duration is ignored (cpm.ts: "derived from its children"); 0 is written
      // so a reader cannot mistake a leftover 8 for an input to the rollup.
      makeTask(1, { durationHours: 0 }),
      makeTask(2, {
        parentId: taskId(1),
        durationHours: 16,
        scheduleMode: 'manual',
        manualStart: '2026-09-08T08:00:00.000Z', // wh 8
        manualFinish: '2026-09-09T16:00:00.000Z', // wh 24
      }),
      makeTask(3, { parentId: taskId(1), durationHours: 8 }),
      makeTask(4, { durationHours: 8 }),
      makeTask(5, { durationHours: 8 }),
    ],
    dependencies: [makeDependency(1, 4, 2), makeDependency(2, 4, 3), makeDependency(3, 2, 5)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-08T08:00:00.000Z', // wh 8  = min(child ES)
        ef: '2026-09-09T16:00:00.000Z', // wh 24 = max(child EF)
        ls: '2026-09-08T08:00:00.000Z', // wh 8  = ES + float = 8 + 0   — ESC-2
        lf: '2026-09-09T16:00:00.000Z', // wh 24 = EF + float = 24 + 0  — ESC-2
        floatHours: 0, // = min(child float) = min(t2 0, t3 16)
        durationHours: 16, // working-hour span wh 8 -> wh 24
      }),
      taskSchedule(2, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-08T08:00:00.000Z',
        lf: '2026-09-09T16:00:00.000Z',
        floatHours: 0,
        start: '2026-09-08T08:00:00.000Z', // the user's fixed dates (FR-TSK-05)
        finish: '2026-09-09T16:00:00.000Z',
        durationHours: 16,
      }),
      taskSchedule(3, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-10T08:00:00.000Z', // wh 24
        lf: '2026-09-10T16:00:00.000Z', // wh 32
        floatHours: 16,
        durationHours: 8,
      }),
      taskSchedule(4, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-07T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(5, {
        es: '2026-09-10T08:00:00.000Z', // wh 24
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(3)],
    projectFinish: '2026-09-10T16:00:00.000Z',
    metrics: metrics({ tasks: 5, edges: 3, depth: 3 }),
  }),
};

// =============================================================================================
// F08 — a manual task whose predecessor overruns it (FR-SCH-08)
// =============================================================================================
/**
 * FR-SCH-08's exact wording: "manually-scheduled tasks shall not move but shall visually flag a
 * resulting date conflict (predecessor finishes after a manual task's fixed start, for FS)". So the
 * *only* correct outcome is a warning plus untouched dates — rejecting the edit, or quietly moving
 * the task, are both different products.
 *
 * ```
 *   t1 X  auto,   24h
 *   t2 M  manual, fixed 2026-09-08T08:00Z .. 2026-09-08T16:00Z  = wh 8 .. 16, 8h
 *   edge  d1 X -FS+0-> M
 * ```
 * t2 has no successor, on purpose — see ESC-6.
 *
 * Forward pass (wh):
 * ```
 *   t1 X  ES = 0                              EF = 0 + 24 = 24
 *   t2 M  graph-implied ES = t1.EF = 24       EF = 24 + 8 = 32
 *         fixed start = 8 < 24  ->  CONFLICT. Dates stay at wh 8..16; ES/EF report wh 24..32.
 *   projectFinish = max(earlyFinish) = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t2 M  no successor       LF = 32                LS = 32 - 8  = 24
 *   t1 X  FS to t2           LF = t2.LS = 24        LS = 24 - 24 =  0
 * ```
 * Float: X `0-0=0`, M `24-24=0`. Both critical — float is computed against the graph-implied ES,
 * which is what `cpm.ts` means by "ES/EF still report where the graph would have put it".
 *
 * The `manual_conflict` diagnostic names the edge and carries `earliestFeasibleStart` = wh 24 =
 * 2026-09-10T08:00Z, so the client can offer "switch to auto" without recomputing anything.
 */
export const F08_MANUAL_CONFLICT: GoldenFixture = {
  id: 'F08-manual-conflict',
  proves:
    'A manual task whose FS predecessor finishes after its fixed start keeps its dates, is flagged, and produces a manual_conflict warning rather than a rejection.',
  requirements: ['FR-TSK-05', 'FR-SCH-08'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 24 }),
      makeTask(2, {
        durationHours: 8,
        scheduleMode: 'manual',
        manualStart: '2026-09-08T08:00:00.000Z', // wh 8
        manualFinish: '2026-09-08T16:00:00.000Z', // wh 16
      }),
    ],
    dependencies: [makeDependency(1, 1, 2)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-09T16:00:00.000Z',
        floatHours: 0,
        durationHours: 24,
      }),
      taskSchedule(2, {
        es: '2026-09-10T08:00:00.000Z', // wh 24 — where the graph would have put it
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        start: '2026-09-08T08:00:00.000Z', // unmoved (FR-SCH-08)
        finish: '2026-09-08T16:00:00.000Z',
        durationHours: 8,
        conflict: true,
      }),
    ],
    criticalDependencyIds: [dependencyId(1)],
    projectFinish: '2026-09-10T16:00:00.000Z',
    diagnostics: [
      {
        code: 'manual_conflict',
        severity: 'warning',
        taskId: taskId(2),
        dependencyId: dependencyId(1),
        predecessorId: taskId(1),
        earliestFeasibleStart: '2026-09-10T08:00:00.000Z', // wh 24
      },
    ],
    metrics: metrics({ tasks: 2, edges: 1, depth: 2 }),
  }),
};

// =============================================================================================
// F09 — MSO (Must Start On)
// =============================================================================================
/**
 * A hard pin on the start. `t2` cannot move in either direction, so it reports float 0 and hands
 * the slack it absorbed to its predecessor.
 *
 * ```
 *   t1 A  8h  -FS+0->  t2 B  8h, MSO 2026-09-10T08:00Z = wh 24
 * ```
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                                    EF =  0 + 8 =  8
 *   t2  predecessors imply ES = 8; MSO pins ES = 24 (later, so satisfiable: no diagnostic)
 *                                                 EF = 24 + 8 = 32
 *   projectFinish = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t2  MSO pins LS = 24 as well                  LF = 24 + 8 = 32
 *   t1  FS to t2       LF = t2.LS = 24            LS = 24 - 8 = 16
 * ```
 * Float: t1 `16-0=16`, t2 `24-24=0`.
 *
 * The check that matters is t1's 16, not t2's 0. If MSO only pinned the forward pass, t2's LS would
 * have come from projectFinish (LS = 32 - 8 = 24 — the same number by coincidence here) but t1's
 * would too, and pinning-vs-flooring would be indistinguishable. Pinning LS is what makes MSO
 * different from SNET (F11), where the identical forward result comes with a different backward one.
 *
 * `criticalDependencyIds` is empty even though t2 is critical: the edge's predecessor is not.
 */
export const F09_MSO: GoldenFixture = {
  id: 'F09-constraint-mso',
  proves:
    'MSO pins the start in both passes, so the constrained task has float 0 and its predecessor absorbs the slack.',
  requirements: ['FR-TSK-06', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, {
        durationHours: 8,
        constraintType: 'MSO',
        constraintDate: '2026-09-10T08:00:00.000Z', // wh 24
      }),
    ],
    dependencies: [makeDependency(1, 1, 2)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-09T08:00:00.000Z', // wh 16
        lf: '2026-09-09T16:00:00.000Z', // wh 24
        floatHours: 16,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-10T08:00:00.000Z', // wh 24
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [],
    projectFinish: '2026-09-10T16:00:00.000Z',
    metrics: metrics({ tasks: 2, edges: 1, depth: 2 }),
  }),
};

// =============================================================================================
// F10 — MFO (Must Finish On)
// =============================================================================================
/**
 * The same pin, applied to the finish. The start is then derived as `C - duration`, which is the
 * step an FS-shaped implementation skips.
 *
 * ```
 *   t1 A  8h  -FS+0->  t2 B  8h, MFO 2026-09-11T16:00Z = wh 40
 * ```
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                       EF =  0 + 8  =  8
 *   t2  MFO pins EF = 40             ES = 40 - 8  = 32   (predecessors imply only 8: satisfiable)
 *   projectFinish = 40
 * ```
 * Backward pass (wh):
 * ```
 *   t2  MFO pins LF = 40             LS = 40 - 8  = 32
 *   t1  FS to t2   LF = t2.LS = 32   LS = 32 - 8  = 24
 * ```
 * Float: t1 `24-0=24`, t2 `32-32=0`.
 */
export const F10_MFO: GoldenFixture = {
  id: 'F10-constraint-mfo',
  proves:
    'MFO pins the finish in both passes and back-derives the start as constraintDate - duration.',
  requirements: ['FR-TSK-06'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, {
        durationHours: 8,
        constraintType: 'MFO',
        constraintDate: '2026-09-11T16:00:00.000Z', // wh 40
      }),
    ],
    dependencies: [makeDependency(1, 1, 2)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-10T08:00:00.000Z', // wh 24
        lf: '2026-09-10T16:00:00.000Z', // wh 32
        floatHours: 24,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-11T08:00:00.000Z', // wh 32
        ef: '2026-09-11T16:00:00.000Z', // wh 40
        ls: '2026-09-11T08:00:00.000Z',
        lf: '2026-09-11T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [],
    projectFinish: '2026-09-11T16:00:00.000Z',
    metrics: metrics({ tasks: 2, edges: 1, depth: 2 }),
  }),
};

// =============================================================================================
// F11 — SNET (Start No Earlier Than)
// =============================================================================================
/**
 * A floor on the start, not a pin. The forward result matches what MSO would have produced for the
 * same date, and the backward result does not — which is the whole test.
 *
 * ```
 *   t1 A  8h  -FS+0->  t2 B  8h, SNET 2026-09-09T08:00Z = wh 16  -FS+0->  t3 C  8h
 * ```
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                                       EF =  0 + 8 =  8
 *   t2  ES = max(predecessor-implied 8, SNET 16) = 16   EF = 16 + 8 = 24
 *   t3  ES = t2.EF = 24                              EF = 24 + 8 = 32
 *   projectFinish = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t3  no successor       LF = 32                   LS = 32 - 8 = 24
 *   t2  FS to t3           LF = t3.LS = 24           LS = 24 - 8 = 16   (SNET is a lower bound on
 *                                                                       the start and 16 >= 16, so
 *                                                                       it does not bind here)
 *   t1  FS to t2           LF = t2.LS = 16           LS = 16 - 8 =  8
 * ```
 * Float: t1 `8-0=8`, t2 `16-16=0`, t3 `24-24=0`.
 *
 * Contrast with F09: had this been MSO at wh 16, t2's LS would have been pinned to 16 identically —
 * but t2's *successor* t3 would then have had to absorb its own slack rather than being pulled
 * critical. The distinguishing evidence here is that t2 stays critical because the downstream chain,
 * not the constraint, fixes its late start.
 */
export const F11_SNET: GoldenFixture = {
  id: 'F11-constraint-snet',
  proves:
    'SNET raises the early start to the constraint date and leaves the backward pass to the successors — a floor, not a pin.',
  requirements: ['FR-TSK-06', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, {
        durationHours: 8,
        constraintType: 'SNET',
        constraintDate: '2026-09-09T08:00:00.000Z', // wh 16
      }),
      makeTask(3, { durationHours: 8 }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 2, 3)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-08T08:00:00.000Z', // wh 8
        lf: '2026-09-08T16:00:00.000Z', // wh 16
        floatHours: 8,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-09T08:00:00.000Z', // wh 16
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-09T08:00:00.000Z',
        lf: '2026-09-09T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-10T08:00:00.000Z', // wh 24
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(2)],
    projectFinish: '2026-09-10T16:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 3 }),
  }),
};

// =============================================================================================
// F12 — SNLT, violated: negative float and a warning
// =============================================================================================
/**
 * The corpus's over-constrained case. `cpm.ts` is explicit about the required behaviour: "The engine
 * still schedules — it honours the constraint and lets float go negative — and flags the task."
 * Rejecting would lose the user's work; silently relaxing the constraint would hide the problem.
 *
 * ```
 *   t1 A  16h  -FS+0->  t2 B  8h, SNLT 2026-09-08T08:00Z = wh 8
 * ```
 * Forward pass (wh) — SNLT is a *late* bound, so it cannot pull ES back:
 * ```
 *   t1  ES = 0                       EF =  0 + 16 = 16
 *   t2  ES = t1.EF = 16              EF = 16 + 8  = 24      <- 16 > 8, the constraint is violated
 *   projectFinish = 24
 * ```
 * Backward pass (wh):
 * ```
 *   t2  no successor:   LS <= projectFinish - duration = 24 - 8 = 16
 *       SNLT:           LS <= 8
 *       LS = min(16, 8) = 8            LF = 8 + 8 = 16
 *   t1  FS to t2        LF = t2.LS = 8                LS = 8 - 16 = -8
 * ```
 * Float: t1 `-8 - 0 = -8`, t2 `8 - 16 = -8`. **Both negative**, and the negative float propagates
 * back through the whole chain — which is the point: a late-bound violation is a statement about
 * every predecessor, not just the constrained task.
 *
 * t1's late start lands *before* the project start, at wh -8. That is correct CPM and the day table
 * extends backwards for it: wh -8 = Friday 2026-09-04 08:00Z, and 16 working hours from there
 * (8 on Fri 09-04, 8 on Mon 09-07) reaches LF = wh 8 = Monday 09-07 16:00Z.
 *
 * `isCritical` is **true** on both tasks. Float -8 is not zero, and the corpus originally read
 * FR-SCH-05's "Float = 0" literally and reported both as non-critical; ESC-4 was raised against
 * exactly that, and docs/FRS.md v1.2 tightened the requirement to `Float <= 0`. On this fixture the
 * literal reading marked **nothing** critical on a project that is already late — FR-SCH-10 would
 * have had no path to highlight at the moment a user most needs one — and t1 -> t2 is plainly the
 * chain driving the overrun. The flag is derived in `taskSchedule()`, so this fixture states the
 * float and the ruling supplies the rest; the change was one line in `common.ts`.
 *
 * Both endpoints of d1 are now critical and the edge is driving (t2.ES = t1.EF exactly), so d1 is a
 * critical dependency. `criticalDependencyIds` was `[]` under the old reading — that emptiness on an
 * over-constrained project is the same bug seen from the edge side.
 *
 * `hasScheduleConflict` is set on t2 only: the flag marks the task carrying the unsatisfiable
 * constraint, not everything the violation propagates through.
 */
export const F12_SNLT_VIOLATED: GoldenFixture = {
  id: 'F12-constraint-snlt-violated',
  proves:
    'An unsatisfiable SNLT still schedules: float goes negative on the constrained task and back through its predecessors, and a constraint_violation warning is emitted.',
  requirements: ['FR-TSK-06', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 16 }),
      makeTask(2, {
        durationHours: 8,
        constraintType: 'SNLT',
        constraintDate: '2026-09-08T08:00:00.000Z', // wh 8
      }),
    ],
    dependencies: [makeDependency(1, 1, 2)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-04T08:00:00.000Z', // wh -8 — before the project start
        lf: '2026-09-07T16:00:00.000Z', // wh 8
        floatHours: -8,
        durationHours: 16,
      }),
      taskSchedule(2, {
        es: '2026-09-09T08:00:00.000Z', // wh 16
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-08T08:00:00.000Z', // wh 8 — the SNLT date
        lf: '2026-09-08T16:00:00.000Z', // wh 16
        floatHours: -8,
        durationHours: 8,
        conflict: true,
      }),
    ],
    // Both endpoints critical (float -8 <= 0, ESC-4) and the edge is driving: t2.ES == t1.EF.
    criticalDependencyIds: [dependencyId(1)],
    projectFinish: '2026-09-09T16:00:00.000Z',
    diagnostics: [
      {
        code: 'constraint_violation',
        severity: 'warning',
        taskId: taskId(2),
        constraintType: 'SNLT',
        requiredDate: '2026-09-08T08:00:00.000Z', // what the constraint demands
        computedDate: '2026-09-09T08:00:00.000Z', // what the predecessors imply (wh 16)
      },
    ],
    metrics: metrics({ tasks: 2, edges: 1, depth: 2 }),
  }),
};

// =============================================================================================
// F13 — FNET, binding and non-binding in the same graph
// =============================================================================================
/**
 * FNET is a floor on the finish. One fixture, two tasks, so both halves of "floor" are proved: t2's
 * constraint pushes it out, t3's identical-shaped constraint does nothing because it is already
 * satisfied. An implementation that treats FNET as a pin (i.e. as MFO) fails on t3, not t2.
 *
 * ```
 *   t1 A  8h  -FS+0->  t2 B  8h, FNET 2026-09-11T16:00Z = wh 40   (binds)
 *   t1 A  8h  -FS+0->  t3 C  8h, FNET 2026-09-07T16:00Z = wh  8   (does not bind)
 * ```
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                                              EF =  0 + 8 =  8
 *   t2  predecessors imply EF = 8 + 8 = 16; FNET floor 40   EF = max(16, 40) = 40
 *                                                           ES = 40 - 8 = 32
 *   t3  predecessors imply EF = 8 + 8 = 16; FNET floor  8   EF = max(16,  8) = 16   (unchanged)
 *                                                           ES = 8
 *   projectFinish = max(8, 40, 16) = 40
 * ```
 * Backward pass (wh):
 * ```
 *   t2  no successor    LF = 40                    LS = 40 - 8 = 32
 *   t3  no successor    LF = 40                    LS = 40 - 8 = 32
 *   t1  LF = min(t2.LS, t3.LS) = 32                LS = 32 - 8 = 24
 * ```
 * Float: t1 `24-0=24`, t2 `32-32=0`, t3 `32-8=24`.
 *
 * `criticalDependencyIds` is empty: t2 is critical but t1 is not, and t3 is not either.
 */
export const F13_FNET: GoldenFixture = {
  id: 'F13-constraint-fnet',
  proves:
    'FNET is a floor on the finish: it pushes a task that would finish earlier and leaves a task that already finishes later alone.',
  requirements: ['FR-TSK-06'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, {
        durationHours: 8,
        constraintType: 'FNET',
        constraintDate: '2026-09-11T16:00:00.000Z', // wh 40 — binds
      }),
      makeTask(3, {
        durationHours: 8,
        constraintType: 'FNET',
        constraintDate: '2026-09-07T16:00:00.000Z', // wh 8 — already satisfied
      }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 1, 3)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-10T08:00:00.000Z', // wh 24
        lf: '2026-09-10T16:00:00.000Z', // wh 32
        floatHours: 24,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-11T08:00:00.000Z', // wh 32
        ef: '2026-09-11T16:00:00.000Z', // wh 40
        ls: '2026-09-11T08:00:00.000Z',
        lf: '2026-09-11T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-11T08:00:00.000Z', // wh 32
        lf: '2026-09-11T16:00:00.000Z', // wh 40
        floatHours: 24,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [],
    projectFinish: '2026-09-11T16:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 2 }),
  }),
};

// =============================================================================================
// F14 — FNLT, satisfiable
// =============================================================================================
/**
 * A ceiling on the finish that the graph *can* meet. It leaves the forward pass alone and tightens
 * the backward one, so the only visible effect is a smaller float — which is exactly the case an
 * implementation is most likely to drop, because nothing moves and nothing is flagged.
 *
 * ```
 *   t1 A  8h  -FS+0->  t2 B   8h, FNLT 2026-09-09T16:00Z = wh 24
 *   t1 A  8h  -FS+0->  t3 C  32h
 * ```
 * t3 is the long parallel leg that carries the project finish out to wh 40, so that without the
 * FNLT t2 would have had float 40 - 16 = 24.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                     EF =  0 + 8  =  8
 *   t2  ES = t1.EF = 8             EF =  8 + 8  = 16      (16 <= 24: satisfiable, no diagnostic)
 *   t3  ES = t1.EF = 8             EF =  8 + 32 = 40
 *   projectFinish = 40
 * ```
 * Backward pass (wh):
 * ```
 *   t3  no successor        LF = 40                       LS = 40 - 32 =  8
 *   t2  no successor:       LF <= projectFinish = 40
 *       FNLT:               LF <= 24
 *       LF = min(40, 24) = 24                             LS = 24 - 8  = 16
 *   t1  LF = min(t2.LS, t3.LS) = min(16, 8) = 8           LS =  8 - 8  =  0
 * ```
 * Float: t1 `0-0=0`, t2 `16-8=8` (**not 24** — the FNLT removed 16 hours of it), t3 `8-8=0`.
 * Critical path t1 -> t3.
 */
export const F14_FNLT: GoldenFixture = {
  id: 'F14-constraint-fnlt',
  proves:
    'A satisfiable FNLT moves nothing on the forward pass and tightens the backward pass, reducing the task’s float without flagging anything.',
  requirements: ['FR-TSK-06', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, {
        durationHours: 8,
        constraintType: 'FNLT',
        constraintDate: '2026-09-09T16:00:00.000Z', // wh 24
      }),
      makeTask(3, { durationHours: 32 }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 1, 3)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-07T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-09T08:00:00.000Z', // wh 16
        lf: '2026-09-09T16:00:00.000Z', // wh 24 — the FNLT date
        floatHours: 8,
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-11T16:00:00.000Z', // wh 40
        ls: '2026-09-08T08:00:00.000Z',
        lf: '2026-09-11T16:00:00.000Z',
        floatHours: 0,
        durationHours: 32,
      }),
    ],
    criticalDependencyIds: [dependencyId(2)],
    projectFinish: '2026-09-11T16:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 2 }),
  }),
};

// =============================================================================================
// F15 — ALAP
// =============================================================================================
/**
 * The eighth constraint type, and the only one that separates a task's *analysis* dates from its
 * *persisted* dates without the task being manual. See ESC-5: this corpus reads ALAP as moving
 * `start`/`finish` to the late dates while `earlyStart`/`earlyFinish` keep reporting the early ones,
 * mirroring the split `cpm.ts` already specifies for manual tasks. The alternative reading — ALAP
 * rewrites ES to LS and the task reports float 0 — is a live possibility and would change t2's
 * `earlyStart`, `earlyFinish` and `totalFloatHours` here.
 *
 * ```
 *   t1 A  8h  -FS+0->  t2 B   8h, ALAP
 *   t1 A  8h  -FS+0->  t3 C  24h
 * ```
 * Forward pass (wh) — ALAP does not change it:
 * ```
 *   t1  ES = 0                 EF =  0 + 8  =  8
 *   t2  ES = t1.EF = 8         EF =  8 + 8  = 16
 *   t3  ES = t1.EF = 8         EF =  8 + 24 = 32
 *   projectFinish = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t3  no successor     LF = 32                      LS = 32 - 24 =  8
 *   t2  no successor     LF = 32                      LS = 32 - 8  = 24
 *   t1  LF = min(t2.LS, t3.LS) = min(24, 8) = 8       LS =  8 - 8  =  0
 * ```
 * Float: t1 `0-0=0`, t2 `24-8=16`, t3 `8-8=0`.
 *
 * ALAP then sets t2's persisted dates to its late dates: start = LS = wh 24 = 2026-09-10T08:00Z,
 * finish = LF = wh 32 = 2026-09-10T16:00Z — 16 working hours later than its early dates, which is
 * precisely its float. t1 and t3 are ASAP, so for them start/finish stay equal to ES/EF; between
 * them this fixture is also the corpus's coverage of ASAP as an explicit expectation rather than an
 * assumed default.
 */
export const F15_ALAP: GoldenFixture = {
  id: 'F15-constraint-alap',
  proves:
    'ALAP consumes a task’s float in the persisted start/finish while ES/EF and totalFloatHours keep reporting the early schedule; ASAP siblings are unaffected.',
  requirements: ['FR-TSK-06', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, { durationHours: 8, constraintType: 'ALAP' }),
      makeTask(3, { durationHours: 24 }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 1, 3)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-07T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-10T08:00:00.000Z', // wh 24
        lf: '2026-09-10T16:00:00.000Z', // wh 32
        floatHours: 16,
        start: '2026-09-10T08:00:00.000Z', // ALAP: the late dates are the persisted ones
        finish: '2026-09-10T16:00:00.000Z',
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-08T08:00:00.000Z', // wh 8
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-08T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        durationHours: 24,
      }),
    ],
    criticalDependencyIds: [dependencyId(2)],
    projectFinish: '2026-09-10T16:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 2 }),
  }),
};

// =============================================================================================
// F20 — a manual task's successor schedules from the MANUAL finish (ESC-6)
// =============================================================================================
/**
 * The fixture ESC-6 asked for. `cpm.ts` gives a manual task two finishes: `finish`, the user's fixed
 * date, and `earlyFinish`, "where the graph would have put it". A successor has to pick one, and
 * neither the FRS nor the contract said which — so the corpus originally sidestepped the question
 * (F07's manual dates coincide with the graph-implied ones; F08's manual task has no successor) and
 * escalated instead of guessing. **Ruled: the manual finish.** The manual dates are the commitment
 * the user made; a successor that quietly scheduled off the early finish would be planning against
 * a date nobody agreed to, which makes manual mode useless for anything downstream of it.
 *
 * This fixture is built so the two readings give **different literals**, which is the only reason it
 * is worth committing:
 *
 * ```
 *   t1 A  auto,   8h
 *   t2 M  manual, 4h, fixed 2026-09-10T08:00Z .. 2026-09-10T12:00Z  = wh 24 .. 28
 *   t3 Z  auto,   8h
 *   edges: d1 A -FS+0-> M,  d2 M -FS+0-> Z
 * ```
 *
 * Forward pass (wh):
 * ```
 *   t1 A  ES = 0                              EF =  0 + 8 =  8
 *   t2 M  graph-implied ES = t1.EF = 8        EF =  8 + 4 = 12
 *         fixed start wh 24 >= 8, so nothing is violated: no conflict, no diagnostic (contrast F08,
 *         where the fixed start is EARLIER than the predecessor's finish). Dates stay wh 24..28 and
 *         ES/EF keep reporting wh 8..12.
 *   t3 Z  ES = t2.FINISH = 24 + 4 = 28        EF = 28 + 8 = 36
 *   projectFinish = max(EF) = max(8, 12, 36) = 36
 * ```
 *
 * **t3's ES is the whole fixture.** Under the ruling it is wh 28 = `2026-09-10T12:00Z`, the same
 * instant as t2's manual finish, to the minute. Under the rejected reading it would have been t2's
 * graph-implied `earlyFinish`, wh 12 = `2026-09-08T12:00Z` — two calendar days earlier, and the
 * project would have finished at wh 20 instead of 36. Both instants sit at midday, inside a working
 * window, so neither depends on the day-boundary convention: an implementation cannot land on the
 * right answer by rounding.
 *
 * Backward pass (wh):
 * ```
 *   t3 Z  no successor         LF = 36                     LS = 36 - 8 = 28
 *   t2 M  FS to t3             LF = t3.LS = 28             LS = 28 - 4 = 24
 *   t1 A  FS to t2             LF = t2.LS = 24             LS = 24 - 8 = 16
 * ```
 * Float = LS - ES: A `16-0=16`, M `24-8=16`, Z `28-28=0`.
 *
 * A manual task's LS/LF are **derived from its successors like anyone else's**, not pinned to its
 * manual dates — F08 already committed to that (its manual task's fixed dates are wh 8..16 while its
 * LS/LF are wh 24..32), and this fixture follows it rather than re-opening it. Here the two happen
 * to coincide, at wh 24..28, because t3 is critical and starts exactly at t2's manual finish. That
 * coincidence is deliberate: F20's job is to pin the *forward* question ESC-6 asked, and it should
 * not also be the fixture that decides a backward-pass rule by accident.
 *
 * Note the shape of the result: t2 drives the project finish yet is not critical, because float is
 * `LS - ES` and its ES is where the *graph* would have started it (wh 8), 16 hours before the date
 * the user pinned. That is the same ES/EF-versus-start/finish split F08 and F15 (ALAP) show, seen
 * from the successor side. It also empties `criticalDependencyIds`: d2's predecessor t2 is not
 * critical, so the driving edge is not a critical one. Discomfort with that is a legitimate question
 * about how manual dates should interact with float — but it is FR-TSK-05's semantics as `cpm.ts`
 * already specifies them, not something this fixture invents.
 *
 * Dates: wh 8 -> Tue 09-08 08:00 (start) / Mon 09-07 16:00 (finish), wh 12 -> Tue 09-08 12:00,
 * wh 16 -> Wed 09-09 08:00 (start), wh 24 -> Thu 09-10 08:00 (start) / Wed 09-09 16:00 (finish),
 * wh 28 -> Thu 09-10 12:00, wh 36 -> Fri 09-11 12:00.
 */
export const F20_MANUAL_FINISH_DRIVES_SUCCESSOR: GoldenFixture = {
  id: 'F20-manual-finish-drives-successor',
  proves:
    'A successor of a manual task starts from the manual task’s fixed finish, not from the graph-implied earlyFinish it reports alongside it (ESC-6).',
  requirements: ['FR-TSK-05', 'FR-SCH-01', 'FR-SCH-04', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, {
        durationHours: 4,
        scheduleMode: 'manual',
        // Chosen so the manual finish (wh 28) and the graph-implied earlyFinish (wh 12) are
        // different instants — a manual task pinned to its graph dates proves nothing here.
        manualStart: '2026-09-10T08:00:00.000Z', // wh 24
        manualFinish: '2026-09-10T12:00:00.000Z', // wh 28
      }),
      makeTask(3, { durationHours: 8 }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 2, 3)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-07T16:00:00.000Z', // wh 8
        ls: '2026-09-09T08:00:00.000Z', // wh 16
        lf: '2026-09-09T16:00:00.000Z', // wh 24
        floatHours: 16,
        durationHours: 8,
      }),
      taskSchedule(2, {
        es: '2026-09-08T08:00:00.000Z', // wh 8  — where the graph would have put it
        ef: '2026-09-08T12:00:00.000Z', // wh 12
        ls: '2026-09-10T08:00:00.000Z', // wh 24
        lf: '2026-09-10T12:00:00.000Z', // wh 28
        floatHours: 16,
        start: '2026-09-10T08:00:00.000Z', // the user's fixed dates (FR-TSK-05), unmoved
        finish: '2026-09-10T12:00:00.000Z',
        durationHours: 4,
      }),
      taskSchedule(3, {
        // wh 28 — t2's *manual* finish to the minute, not its earlyFinish (wh 12). ESC-6.
        es: '2026-09-10T12:00:00.000Z',
        ef: '2026-09-11T12:00:00.000Z', // wh 36
        ls: '2026-09-10T12:00:00.000Z',
        lf: '2026-09-11T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    // d2 drives the project finish but its predecessor t2 has float 16, so no edge qualifies.
    criticalDependencyIds: [],
    projectFinish: '2026-09-11T12:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 3 }),
  }),
};
