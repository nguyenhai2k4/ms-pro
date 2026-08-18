import { dependencyId, makeDependency, makeTask } from '../fixtures.js';
import type { GoldenFixture } from './common.js';
import { metrics, scheduled, scheduleInput, taskSchedule } from './common.js';

/**
 * Golden fixtures F01-F06 — the four dependency types, signed lag, and float from a merge.
 *
 * All six use `standardCalendar()` (Mon-Fri 08:00-16:00 UTC, 8 working hours a day) and
 * `PROJECT_START = 2026-09-07T08:00:00.000Z` (a Monday). Derivations are in **working hours since
 * the project start** (`wh`); `common.ts`'s header carries the `wh` -> date table and the
 * start-normalises-forward / finish-normalises-backward boundary rule that turns a `wh` into a
 * literal. Every literal below was produced by reading that table, not by running anything.
 *
 * The four relations, written once so the fixtures can refer to them (FR-SCH-01, FR-SCH-02; `P` is
 * the predecessor, `S` the successor, `L` the signed lag in working hours):
 *
 * ```
 *   FS   S.ES >= P.EF + L        backward:  P.LF <= S.LS - L
 *   SS   S.ES >= P.ES + L        backward:  P.LS <= S.LS - L
 *   FF   S.EF >= P.EF + L        backward:  P.LF <= S.LF - L
 *   SF   S.EF >= P.ES + L        backward:  P.LS <= S.LF - L
 * ```
 *
 * Two consequences of that table are load-bearing and are each given their own fixture:
 * SS/SF bound the *predecessor's late start* rather than its late finish (F02, F04), and FF/SF
 * bound the *successor's early finish* rather than its early start, so the successor's ES is then
 * derived as EF - duration (F03, F04).
 */

// =============================================================================================
// F01 — a pure FS chain, zero lag
// =============================================================================================
/**
 * The base case. If this fails, nothing else in the corpus is worth reading.
 *
 * Graph: `t1(8h) -FS-> t2(16h) -FS-> t3(4h) -FS-> t4(8h)`, every lag 0.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                     EF = 0 + 8  =  8
 *   t2  ES = t1.EF + 0 =  8        EF = 8 + 16 = 24
 *   t3  ES = t2.EF + 0 = 24        EF = 24 + 4 = 28
 *   t4  ES = t3.EF + 0 = 28        EF = 28 + 8 = 36
 *   projectFinish = max(EF) = 36
 * ```
 * Backward pass (wh) — t4 has no successor, so LF seeds from the project finish:
 * ```
 *   t4  LF = 36                    LS = 36 - 8  = 28
 *   t3  LF = t4.LS - 0 = 28        LS = 28 - 4  = 24
 *   t2  LF = t3.LS - 0 = 24        LS = 24 - 16 =  8
 *   t1  LF = t2.LS - 0 =  8        LS =  8 - 8  =  0
 * ```
 * Float = LS - ES: `0-0, 8-8, 24-24, 28-28` = 0 for all four. Every task critical, every edge
 * driving, so all three dependencies are critical.
 *
 * Dates, from the day table: wh 0 -> Mon 08:00; wh 8 -> start Tue 08:00 / finish Mon 16:00;
 * wh 24 -> start Thu 08:00 / finish Wed 16:00; wh 28 -> Thu 12:00; wh 36 -> Fri 12:00.
 */
export const F01_FS_CHAIN: GoldenFixture = {
  id: 'F01-fs-chain',
  proves:
    'A 4-task zero-lag FS chain schedules end-to-end, and an unbroken chain is entirely critical.',
  requirements: ['FR-SCH-01', 'FR-SCH-04', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, { durationHours: 16 }),
      makeTask(3, { durationHours: 4 }),
      makeTask(4, { durationHours: 8 }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 2, 3), makeDependency(3, 3, 4)],
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
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-08T08:00:00.000Z',
        lf: '2026-09-09T16:00:00.000Z',
        floatHours: 0,
        durationHours: 16,
      }),
      taskSchedule(3, {
        es: '2026-09-10T08:00:00.000Z', // wh 24
        ef: '2026-09-10T12:00:00.000Z', // wh 28
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-10T12:00:00.000Z',
        floatHours: 0,
        durationHours: 4,
      }),
      taskSchedule(4, {
        es: '2026-09-10T12:00:00.000Z', // wh 28
        ef: '2026-09-11T12:00:00.000Z', // wh 36
        ls: '2026-09-10T12:00:00.000Z',
        lf: '2026-09-11T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(2), dependencyId(3)],
    projectFinish: '2026-09-11T12:00:00.000Z',
    metrics: metrics({ tasks: 4, edges: 3, depth: 4 }),
  }),
};

// =============================================================================================
// F02 — SS with positive lag
// =============================================================================================
/**
 * An SS link offsets the successor's *start* from the predecessor's *start*, and — the part
 * implementations miss — it bounds the predecessor's **late start**, not its late finish.
 *
 * Graph: `t1(16h) -SS+4-> t2(8h) -FS+0-> t3(8h)`.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                        EF = 0 + 16 = 16
 *   t2  ES = t1.ES + 4 = 4            EF = 4 + 8  = 12      <- starts before t1 finishes
 *   t3  ES = t2.EF + 0 = 12           EF = 12 + 8 = 20
 *   projectFinish = max(EF) = max(16, 12, 20) = 20
 * ```
 * Backward pass (wh):
 * ```
 *   t3  no successor      LF = 20                 LS = 20 - 8  = 12
 *   t2  FS to t3          LF = t3.LS - 0 = 12     LS = 12 - 8  =  4
 *   t1  SS to t2 bounds LS, not LF. Two bounds, take the smaller LS:
 *         from SS:  LS <= t2.LS - 4 = 4 - 4 = 0
 *         from "no finish-side successor": LF <= projectFinish = 20, so LS <= 20 - 16 = 4
 *       LS = min(0, 4) = 0,  LF = LS + 16 = 16
 * ```
 * Float = LS - ES: t1 `0-0=0`, t2 `4-4=0`, t3 `12-12=0`. All critical.
 *
 * Note what the SS link does to the shape of the critical path: t1 is critical while finishing at
 * wh 16, eight working hours before the project finish at wh 20. Had the backward pass bounded
 * t1's LF (the FS rule) instead of its LS, t1 would have come out with LS = 4 and float 4 — a
 * silently non-critical task on the real critical path. That substitution is the bug this fixture
 * exists to catch.
 */
export const F02_SS_POSITIVE_LAG: GoldenFixture = {
  id: 'F02-ss-positive-lag',
  proves:
    'SS+4 offsets the successor start from the predecessor start, and bounds the predecessor’s LS (not LF) on the backward pass.',
  requirements: ['FR-SCH-01', 'FR-SCH-02', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 16 }),
      makeTask(2, { durationHours: 8 }),
      makeTask(3, { durationHours: 8 }),
    ],
    dependencies: [makeDependency(1, 1, 2, { type: 'SS', lagHours: 4 }), makeDependency(2, 2, 3)],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-08T16:00:00.000Z',
        floatHours: 0,
        durationHours: 16,
      }),
      taskSchedule(2, {
        es: '2026-09-07T12:00:00.000Z', // wh 4
        ef: '2026-09-08T12:00:00.000Z', // wh 12
        ls: '2026-09-07T12:00:00.000Z',
        lf: '2026-09-08T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-08T12:00:00.000Z', // wh 12
        ef: '2026-09-09T12:00:00.000Z', // wh 20
        ls: '2026-09-08T12:00:00.000Z',
        lf: '2026-09-09T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(2)],
    projectFinish: '2026-09-09T12:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 3 }),
  }),
};

// =============================================================================================
// F03 — FF with positive lag
// =============================================================================================
/**
 * An FF link pushes the successor's *finish*; the successor's start is then derived backwards as
 * EF - duration. t2 here has no predecessor on its start side at all, so the only thing placing it
 * is the FF constraint on its finish.
 *
 * Graph: `t1(16h) -FF+8-> t2(8h)`.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                                    EF = 0 + 16 = 16
 *   t2  EF >= t1.EF + 8 = 24, and with no start-side predecessor the unconstrained EF would be
 *       0 + 8 = 8, so EF = max(8, 24) = 24
 *       ES = EF - duration = 24 - 8 = 16
 *   projectFinish = max(EF) = 24
 * ```
 * Backward pass (wh):
 * ```
 *   t2  no successor       LF = 24                LS = 24 - 8  = 16
 *   t1  FF to t2           LF = t2.LF - 8 = 16    LS = 16 - 16 =  0
 * ```
 * Float: t1 `0-0=0`, t2 `16-16=0`. Both critical; the FF edge is driving (t2.EF is exactly
 * t1.EF + 8), so it is critical.
 *
 * The trap: deriving t2.ES from t1.EF the way an FS link would gives ES = 16 by coincidence here
 * *only* because duration 8 happens to equal the lag. Change the lag to 12 and an FS-shaped
 * implementation gives ES 16 / EF 24 where the correct answer is ES 20 / EF 28.
 */
export const F03_FF_POSITIVE_LAG: GoldenFixture = {
  id: 'F03-ff-positive-lag',
  proves:
    'FF+8 pushes the successor’s early finish, and its early start is derived as EF - duration rather than from the predecessor’s finish.',
  requirements: ['FR-SCH-01', 'FR-SCH-02'],
  input: scheduleInput({
    tasks: [makeTask(1, { durationHours: 16 }), makeTask(2, { durationHours: 8 })],
    dependencies: [makeDependency(1, 1, 2, { type: 'FF', lagHours: 8 })],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-08T16:00:00.000Z',
        floatHours: 0,
        durationHours: 16,
      }),
      taskSchedule(2, {
        es: '2026-09-09T08:00:00.000Z', // wh 16
        ef: '2026-09-09T16:00:00.000Z', // wh 24
        ls: '2026-09-09T08:00:00.000Z',
        lf: '2026-09-09T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(1)],
    projectFinish: '2026-09-09T16:00:00.000Z',
    metrics: metrics({ tasks: 2, edges: 1, depth: 2 }),
  }),
};

// =============================================================================================
// F04 — SF, the one implementations get wrong
// =============================================================================================
/**
 * Start-to-finish. The relation is `S.EF >= P.ES + lag`: the **predecessor's start** gates the
 * **successor's finish**. Read backwards — which is how it is usually described — the successor's
 * late finish gates the predecessor's late start: `P.LS <= S.LF - lag`.
 *
 * Two things make SF counterintuitive, and this fixture is built so both are visible in the
 * expected values rather than merely asserted:
 *
 *  1. **The successor legitimately starts before the predecessor starts.** t3 begins at wh 16;
 *     t2, its predecessor, begins at wh 24. That is not a bug and an implementation that "fixes"
 *     it by forcing successors after predecessors will fail here.
 *  2. **An SF edge can be on the critical path.** t3 has float 0.
 *
 * Graph: `t1(24h) -FS+0-> t2(8h) -SF+8-> t3(16h)`.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                        EF = 0 + 24  = 24
 *   t2  ES = t1.EF + 0 = 24           EF = 24 + 8  = 32
 *   t3  EF >= t2.ES + 8 = 24 + 8 = 32; unconstrained it would finish at 0 + 16 = 16,
 *       so EF = max(16, 32) = 32 and ES = EF - 16 = 16
 *   projectFinish = max(EF) = max(24, 32, 32) = 32
 * ```
 * Backward pass (wh):
 * ```
 *   t3  no successor          LF = 32                     LS = 32 - 16 = 16
 *   t2  SF to t3 bounds LS:     LS <= t3.LF - 8 = 24
 *       no finish-side successor:  LF <= projectFinish = 32, so LS <= 32 - 8 = 24
 *       LS = min(24, 24) = 24,  LF = 24 + 8 = 32
 *   t1  FS to t2              LF = t2.LS - 0 = 24         LS = 24 - 24 =  0
 * ```
 * Float: t1 `0-0=0`, t2 `24-24=0`, t3 `16-16=0`. All three critical, both edges driving
 * (t2.ES = t1.EF exactly; t3.EF = t2.ES + 8 exactly), so both dependencies are critical.
 */
export const F04_SF_LINK: GoldenFixture = {
  id: 'F04-sf-link',
  proves:
    'SF+8 gates the successor’s finish on the predecessor’s start; the successor may start before its predecessor and still be critical.',
  requirements: ['FR-SCH-01', 'FR-SCH-02', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 24 }),
      makeTask(2, { durationHours: 8 }),
      makeTask(3, { durationHours: 16 }),
    ],
    dependencies: [makeDependency(1, 1, 2), makeDependency(2, 2, 3, { type: 'SF', lagHours: 8 })],
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
        es: '2026-09-10T08:00:00.000Z', // wh 24
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-10T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-09T08:00:00.000Z', // wh 16 — before its own predecessor's start
        ef: '2026-09-10T16:00:00.000Z', // wh 32
        ls: '2026-09-09T08:00:00.000Z',
        lf: '2026-09-10T16:00:00.000Z',
        floatHours: 0,
        durationHours: 16,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(2)],
    projectFinish: '2026-09-10T16:00:00.000Z',
    metrics: metrics({ tasks: 3, edges: 2, depth: 3 }),
  }),
};

// =============================================================================================
// F05 — negative lag (lead)
// =============================================================================================
/**
 * FR-SCH-02's signed lag. A lag of -4 on an FS edge lets the successor start four working hours
 * *before* the predecessor finishes, and the backward pass has to add the same 4 back.
 *
 * Graph: `t1(16h) -FS-4-> t2(8h) -FS+0-> t3(8h)` plus `t1 -FS+0-> t4(4h)`, where t4 is a dead-end
 * branch that exists so the fixture also shows a non-zero float (a lead that shortens the whole
 * project must not make everything critical by accident).
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                          EF = 0 + 16  = 16
 *   t2  ES = t1.EF + (-4) = 12          EF = 12 + 8  = 20    <- overlaps t1 by 4 working hours
 *   t3  ES = t2.EF + 0    = 20          EF = 20 + 8  = 28
 *   t4  ES = t1.EF + 0    = 16          EF = 16 + 4  = 20
 *   projectFinish = max(16, 20, 28, 20) = 28
 * ```
 * Backward pass (wh):
 * ```
 *   t3  no successor        LF = 28                          LS = 28 - 8  = 20
 *   t4  no successor        LF = 28                          LS = 28 - 4  = 24
 *   t2  FS to t3            LF = t3.LS - 0 = 20              LS = 20 - 8  = 12
 *   t1  two FS successors, take the tightest LF:
 *         via t2:  LF <= t2.LS - (-4) = 12 + 4 = 16
 *         via t4:  LF <= t4.LS -   0  = 24
 *       LF = min(16, 24) = 16,  LS = 16 - 16 = 0
 * ```
 * Float: t1 `0-0=0`, t2 `12-12=0`, t3 `20-20=0`, t4 `24-16=8`. t4 is the only non-critical task.
 * Critical dependencies: t1->t2 and t2->t3 (both endpoints critical and both edges driving);
 * t1->t4 is excluded because t4 is not critical.
 *
 * The sign check that matters: subtracting the lag on the backward pass turns -4 into +4. An
 * implementation that adds it instead gives t1.LF = 8, LS = -8 and a spurious float of -8 on the
 * project's first task.
 */
export const F05_NEGATIVE_LAG: GoldenFixture = {
  id: 'F05-negative-lag-lead',
  proves:
    'A negative lag (lead) overlaps successor and predecessor on the forward pass and is subtracted — i.e. added back — on the backward pass.',
  requirements: ['FR-SCH-02', 'FR-SCH-04', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 16 }),
      makeTask(2, { durationHours: 8 }),
      makeTask(3, { durationHours: 8 }),
      makeTask(4, { durationHours: 4 }),
    ],
    dependencies: [
      makeDependency(1, 1, 2, { lagHours: -4 }),
      makeDependency(2, 2, 3),
      makeDependency(3, 1, 4),
    ],
  }),
  expected: scheduled({
    taskSchedules: [
      taskSchedule(1, {
        es: '2026-09-07T08:00:00.000Z', // wh 0
        ef: '2026-09-08T16:00:00.000Z', // wh 16
        ls: '2026-09-07T08:00:00.000Z',
        lf: '2026-09-08T16:00:00.000Z',
        floatHours: 0,
        durationHours: 16,
      }),
      taskSchedule(2, {
        es: '2026-09-08T12:00:00.000Z', // wh 12 — four working hours before t1 finishes
        ef: '2026-09-09T12:00:00.000Z', // wh 20
        ls: '2026-09-08T12:00:00.000Z',
        lf: '2026-09-09T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(3, {
        es: '2026-09-09T12:00:00.000Z', // wh 20
        ef: '2026-09-10T12:00:00.000Z', // wh 28
        ls: '2026-09-09T12:00:00.000Z',
        lf: '2026-09-10T12:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
      taskSchedule(4, {
        es: '2026-09-09T08:00:00.000Z', // wh 16
        ef: '2026-09-09T12:00:00.000Z', // wh 20
        ls: '2026-09-10T08:00:00.000Z', // wh 24
        lf: '2026-09-10T12:00:00.000Z', // wh 28
        floatHours: 8,
        durationHours: 4,
      }),
    ],
    criticalDependencyIds: [dependencyId(1), dependencyId(2)],
    projectFinish: '2026-09-10T12:00:00.000Z',
    metrics: metrics({ tasks: 4, edges: 3, depth: 3 }),
  }),
};

// =============================================================================================
// F06 — diamond with unequal legs
// =============================================================================================
/**
 * The canonical float shape: one source, two parallel legs of different length, one merge. The
 * short leg must come out with float equal to the difference in leg length; the long leg must come
 * out at zero and carry the critical path.
 *
 * Graph: `t1(8h) -> t2(8h) -> t4(8h)` and `t1(8h) -> t3(24h) -> t4(8h)`, all FS, all lag 0.
 * The t2 leg is 8 working hours long; the t3 leg is 24. Difference: 16.
 *
 * Forward pass (wh):
 * ```
 *   t1  ES = 0                                 EF = 0 + 8   =  8
 *   t2  ES = t1.EF          =  8               EF = 8 + 8   = 16
 *   t3  ES = t1.EF          =  8               EF = 8 + 24  = 32
 *   t4  ES = max(t2.EF, t3.EF) = max(16, 32) = 32
 *                                              EF = 32 + 8  = 40
 *   projectFinish = 40
 * ```
 * Backward pass (wh):
 * ```
 *   t4  no successor        LF = 40                      LS = 40 - 8  = 32
 *   t3  FS to t4            LF = t4.LS = 32              LS = 32 - 24 =  8
 *   t2  FS to t4            LF = t4.LS = 32              LS = 32 - 8  = 24
 *   t1  LF = min(t2.LS, t3.LS) = min(24, 8) = 8          LS =  8 - 8  =  0
 * ```
 * Float: t1 `0-0=0`, t2 `24-8=16`, t3 `8-8=0`, t4 `32-32=0`.
 * Critical path t1 -> t3 -> t4; t2 carries exactly the 16 hours by which its leg is shorter.
 *
 * Critical dependencies are the two on the long leg. t2->t4 is excluded twice over: t2 is not
 * critical, *and* the edge is not driving (t4.ES is 32, not t2.EF = 16). Both exclusions matter —
 * an implementation that only checks "both endpoints critical" would wrongly include an edge into
 * a critical merge point from a critical-but-slack predecessor in other graphs.
 */
export const F06_DIAMOND_UNEQUAL_LEGS: GoldenFixture = {
  id: 'F06-diamond-unequal-legs',
  proves:
    'A merge takes max over incoming edges; the short leg gets float equal to the leg-length difference and the long leg is critical.',
  requirements: ['FR-SCH-04', 'FR-SCH-05'],
  input: scheduleInput({
    tasks: [
      makeTask(1, { durationHours: 8 }),
      makeTask(2, { durationHours: 8 }),
      makeTask(3, { durationHours: 24 }),
      makeTask(4, { durationHours: 8 }),
    ],
    dependencies: [
      makeDependency(1, 1, 2),
      makeDependency(2, 1, 3),
      makeDependency(3, 2, 4),
      makeDependency(4, 3, 4),
    ],
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
      taskSchedule(4, {
        es: '2026-09-11T08:00:00.000Z', // wh 32
        ef: '2026-09-11T16:00:00.000Z', // wh 40
        ls: '2026-09-11T08:00:00.000Z',
        lf: '2026-09-11T16:00:00.000Z',
        floatHours: 0,
        durationHours: 8,
      }),
    ],
    criticalDependencyIds: [dependencyId(2), dependencyId(4)],
    projectFinish: '2026-09-11T16:00:00.000Z',
    metrics: metrics({ tasks: 4, edges: 4, depth: 3 }),
  }),
};
