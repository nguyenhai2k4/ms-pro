import type { GoldenFixture } from './common.js';
import {
  F01_FS_CHAIN,
  F02_SS_POSITIVE_LAG,
  F03_FF_POSITIVE_LAG,
  F04_SF_LINK,
  F05_NEGATIVE_LAG,
  F06_DIAMOND_UNEQUAL_LEGS,
} from './dependency-types.js';
import {
  F07_MIXED_MANUAL_AUTO_SUBTREE,
  F08_MANUAL_CONFLICT,
  F09_MSO,
  F10_MFO,
  F11_SNET,
  F12_SNLT_VIOLATED,
  F13_FNET,
  F14_FNLT,
  F15_ALAP,
} from './modes-and-constraints.js';
import {
  F16_CALENDAR_EXCEPTION_MID_TASK,
  F17_FOUR_LEVEL_WBS,
  F18_MILESTONE_CHAIN,
  F19_CYCLE_REJECTED,
} from './calendars-and-structure.js';

/**
 * The golden-file corpus for the CPM engine — P2 work item W2-3, built **before** the forward and
 * backward passes exist (W3-1) so that no expectation in it could have been captured from a running
 * implementation. `common.ts` explains why that ordering is the point rather than an accident, and
 * carries the shared working-time frame, the day table, the boundary convention and `ESCALATIONS` —
 * the list of semantics the FRS does not pin, which W3-1 needs resolved before it builds.
 *
 * ## How this is meant to be consumed
 *
 * W3-1 (`computeSchedule`) and W7-1 (the QA pass) both iterate `GOLDEN_FIXTURES` and assert
 * `computeSchedule(fixture.input)` deep-equals `fixture.expected`. Nothing here imports the engine's
 * scheduling passes, so the corpus stays compilable and testable while they do not exist:
 * `golden-corpus.test.ts` today proves the corpus is *well-formed* (parses against the contract, is
 * internally consistent, and — for F19 — agrees with `detectCycle`), which is everything that can
 * honestly be proved before there is something to compute.
 *
 * ## Coverage, against the qa-engineer charter's priority-1 list
 *
 * ```
 *   FS chain, zero lag ............................. F01
 *   SS with positive lag ........................... F02
 *   FF with positive lag ........................... F03
 *   SF (the least intuitive type) .................. F04
 *   Negative lag / lead ............................ F05
 *   Diamond, unequal legs, nonzero float ........... F06
 *   Mixed manual/auto subtree, rollup .............. F07
 *   Manual conflict flag (FR-SCH-08) ............... F08
 *   Constraints: MSO F09 · MFO F10 · SNET F11 · SNLT (violated) F12 · FNET F13 · FNLT F14
 *                ALAP F15 · ASAP everywhere else, explicitly asserted in F15
 *   Calendar exception mid-task, plus downstream ... F16
 *   Four-level WBS rollup .......................... F17
 *   Milestone chain ................................ F18
 *   Cycle rejection ................................ F19
 * ```
 *
 * ## Not covered here, and deliberately so
 *
 *  - **Incremental recompute equals full recompute.** The highest-yield invariant in the phase, and
 *    a *property* over random graphs rather than a fixture — it belongs with W5-1 and consumes
 *    `makeSyntheticProject` from `../synthetic.js`, not this corpus.
 *  - **`dangling_dependency` / `missing_calendar` / `unusable_calendar` rejections.** Input-integrity
 *    errors, already covered by `graph.test.ts` and reachable without a schedule.
 *  - **A dependency whose endpoint is a summary task.** Its semantics are not settled anywhere in
 *    the FRS, and a fixture would have invented them. Flagged rather than guessed.
 */
export const GOLDEN_FIXTURES: readonly GoldenFixture[] = Object.freeze([
  F01_FS_CHAIN,
  F02_SS_POSITIVE_LAG,
  F03_FF_POSITIVE_LAG,
  F04_SF_LINK,
  F05_NEGATIVE_LAG,
  F06_DIAMOND_UNEQUAL_LEGS,
  F07_MIXED_MANUAL_AUTO_SUBTREE,
  F08_MANUAL_CONFLICT,
  F09_MSO,
  F10_MFO,
  F11_SNET,
  F12_SNLT_VIOLATED,
  F13_FNET,
  F14_FNLT,
  F15_ALAP,
  F16_CALENDAR_EXCEPTION_MID_TASK,
  F17_FOUR_LEVEL_WBS,
  F18_MILESTONE_CHAIN,
  F19_CYCLE_REJECTED,
]);

export type { GoldenFixture } from './common.js';
export {
  ESCALATIONS,
  EXCEPTION_CALENDAR_ID,
  GOLDEN_PROJECT_ID,
  PROJECT_START,
  STANDARD_CALENDAR_ID,
  standardCalendar,
} from './common.js';

export {
  F01_FS_CHAIN,
  F02_SS_POSITIVE_LAG,
  F03_FF_POSITIVE_LAG,
  F04_SF_LINK,
  F05_NEGATIVE_LAG,
  F06_DIAMOND_UNEQUAL_LEGS,
} from './dependency-types.js';
export {
  F07_MIXED_MANUAL_AUTO_SUBTREE,
  F08_MANUAL_CONFLICT,
  F09_MSO,
  F10_MFO,
  F11_SNET,
  F12_SNLT_VIOLATED,
  F13_FNET,
  F14_FNLT,
  F15_ALAP,
} from './modes-and-constraints.js';
export {
  F16_CALENDAR_EXCEPTION_MID_TASK,
  F17_FOUR_LEVEL_WBS,
  F18_MILESTONE_CHAIN,
  F19_CYCLE_REJECTED,
} from './calendars-and-structure.js';
