import type {
  CpmCalendar,
  CpmDependency,
  CpmDiagnostic,
  CpmMetrics,
  CpmScheduledResult,
  CpmScheduleInput,
  CpmScheduleResult,
  CpmTask,
  CpmTaskSchedule,
  DependencyId,
  IsoDateTime,
} from '@projectapp/shared-types';
import { calendarId, projectId, taskId } from '../fixtures.js';

/**
 * Shared scaffolding for the golden-file corpus (P2 work item W2-3).
 *
 * # Read this before adding a fixture
 *
 * **Every expected value in this corpus was derived by hand and is shown as arithmetic in the
 * fixture's own comment block. None of it was captured by running an implementation — at the time
 * of writing there is none to run: `computeSchedule` does not exist, and W3-1 is the work item that
 * will build it *against* these files.** That sequencing is the whole point. An expectation lifted
 * off a running engine proves the engine agrees with itself; it is a tautology wearing a test's
 * clothes, and it is worth nothing on the day the engine is wrong. So each fixture carries its
 * forward pass, its backward pass and its float subtraction written out the way a textbook worked
 * example would, so a reviewer can check the arithmetic without trusting either the author or the
 * code.
 *
 * The one exception is stated where it applies: the cycle fixture's `cyclePath` *may* be checked
 * against `detectCycle`, because cycle detection is W1-1 code that already exists and is already
 * tested. The hand-trace is still written out, because the fixture also has to document *why* the
 * loop is a loop.
 *
 * # The working-time frame every fixture shares
 *
 * Hand-derivation is only tractable against one simple calendar, so unless a fixture says otherwise
 * it uses `standardCalendar()` and `PROJECT_START`:
 *
 *  - Mon-Fri, 08:00-16:00 **UTC** (ADR-011 — the engine does no time-zone conversion), so one
 *    working day is exactly **8 working hours** and durations in hours read as days at a glance.
 *  - `PROJECT_START = 2026-09-07T08:00:00.000Z`, a **Monday**, at the first working minute.
 *
 * Derivations are written in **working hours elapsed since `PROJECT_START`**, abbreviated `wh`. The
 * day table (`wh` -> calendar date) that every fixture indexes into:
 *
 * ```
 *   wh   0.. 8  d0  Mon 2026-09-07      wh  40.. 48  d5  Mon 2026-09-14
 *   wh   8..16  d1  Tue 2026-09-08      wh  48.. 56  d6  Tue 2026-09-15
 *   wh  16..24  d2  Wed 2026-09-09      wh  56.. 64  d7  Wed 2026-09-16
 *   wh  24..32  d3  Thu 2026-09-10      (before the project start, needed once, in F12:)
 *   wh  32..40  d4  Fri 2026-09-11      wh  -8..  0  d-1 Fri 2026-09-04
 *                                       wh -16.. -8  d-2 Thu 2026-09-03
 * ```
 *
 * Within a day, `wh` offset o maps to 08:00 + o hours: 0 -> 08:00, 4 -> 12:00, 8 -> 16:00.
 *
 * # The boundary convention, stated once
 *
 * A working-time point that falls exactly on a day boundary has two wall-clock spellings — Friday
 * 16:00 and Monday 08:00 are the same instant of *working* time. Left unpinned, this is the classic
 * off-by-one-day schedule bug, so the corpus fixes it:
 *
 *  - a **start** (`start`, `earlyStart`, `lateStart`) is normalised **forward**: the earliest
 *    working instant at or after the point. `wh 8` as a start is `2026-09-08T08:00:00.000Z`.
 *  - a **finish** (`finish`, `earlyFinish`, `lateFinish`) is normalised **backward**: the latest
 *    working instant at or before the point. `wh 8` as a finish is `2026-09-07T16:00:00.000Z`.
 *
 * So an 8-hour task on Monday finishes `Mon 16:00` and its FS successor starts `Tue 08:00`, which
 * is what a user expects to see drawn.
 *
 * There is a floor on the backward rule: **normalisation never crosses `projectStart`.** `wh 0` as a
 * finish is `2026-09-07T08:00:00.000Z`, not the previous Friday's 16:00, because no working time
 * precedes the project start as far as this project is concerned. Without that clause the rule would
 * date a milestone at the project start three days before the project.
 *
 * The one case this convention does not settle *by itself* is a **zero-duration** task landing on a
 * day boundary with working time on both sides, where start and finish must be the same instant and
 * the two rules disagree. The calendar kernel settles it: `addWorkingHours(t, 0, calendar)`
 * (`../../calendar.ts`, W2-1) snaps **forward** to the earliest working instant at or after `t`, so
 * a milestone at the Friday-16:00/Monday-08:00 seam sits at Monday 08:00. W3-1 places milestones by
 * calling that same primitive, so there is nothing left to choose (ESC-3, resolved). F18 still keeps
 * its milestones at interior working hours or at the project start — it was written to test
 * FR-TSK-04's "no accumulated span", not the seam, and it stays as it is.
 *
 * # Summary tasks: rollup and late dates (FR-TSK-03 + FR-SCH-05)
 *
 * FR-TSK-03 pins the early side — `ES = min(child ES)`, `EF = max(child EF)`, duration = the
 * working-hour span of that range. Nothing in the FRS pins the late side, and the answer is **not**
 * min/max of the children's late dates (ESC-2, overruled: that rule can report a summary as
 * non-critical while it contains a critical child). What this corpus uses instead:
 *
 * ```
 *   totalFloat(summary) = min( totalFloat(child) ) over its DIRECT children
 *   LS = ES + totalFloat        LF = EF + totalFloat        (both shifts in WORKING time)
 * ```
 *
 * A summary can slip by `d` without pushing the project out exactly when *every* child can, so the
 * binding child is the least slack one — hence `min`. Two properties fall out by construction:
 * `totalFloat === LS - ES` exactly (no rounding, no special case), and a summary containing a child
 * with float `<= 0` is itself critical, which is what FR-SCH-10 needs in order to have a bar to
 * highlight. Both instants are then *spelled* under the boundary convention above: LS forward, LF
 * backward. Note that `addWorkingHours(EF, 0)` would forward-snap a finish sitting on a seam onto
 * the next morning, so a zero-float summary's `LF` is `EF` itself rather than a call through the
 * kernel — a detail W3-1 has to get right and `golden-corpus.test.ts` re-derives independently.
 *
 * # Conventions the FRS did not pin, and how they were settled
 *
 * Recorded in `ESCALATIONS` below rather than buried in whichever fixture happened to hit them
 * first. All six were escalated by W2-3 rather than guessed at, and all six have been ruled on
 * (W2-4) — two of them against what the corpus had adopted, which is why escalating was worth the
 * delay. W3-1 builds against a corpus with no open questions in it.
 */

// ---------------------------------------------------------------------------------------------
// Escalated semantics and the rulings on them — settled before W3-1
// ---------------------------------------------------------------------------------------------

/**
 * Places where the FRS text and `packages/shared-types/src/cpm.ts` did not fully determine an
 * expected value, **the tech-lead's ruling on each**, and the fixtures that carry it.
 *
 * These are **not** rhetorical. Each one changes at least one committed expectation.
 *
 * All six were raised by W2-3 and ruled on before W3-1 (this file's edit history and
 * `docs/FRS.md`'s v1.2 amendment carry the full reasoning; the summaries below are deliberately
 * short). `status` is the disposition of the *question*, and `adopted` always describes the
 * convention **now in force** — never the one that was overruled — so that a reader who scrolls to
 * one entry cannot come away with the superseded rule:
 *
 * ```
 *   ratified   the corpus's original reading stands, unchanged
 *   overruled  the corpus's original reading was wrong; `adopted` is the replacement
 *   ruled      the corpus declined to choose; the ruling picked one and a fixture now pins it
 *   resolved   never actually open once existing merged code was accounted for
 * ```
 *
 * `golden-corpus.test.ts` asserts that no entry is still open, so a seventh escalation cannot be
 * added and then quietly forgotten on the way into an implementation work item.
 */
export const ESCALATIONS = Object.freeze([
  Object.freeze({
    id: 'ESC-1',
    status: 'ratified',
    question: 'What does CpmMetrics.dependenciesTraversed count — edges once, or once per pass?',
    adopted:
      'Once per pass: 2 x |structurally valid edges| (forward relaxation + backward relaxation).',
    affects: 'metrics on every scheduled fixture; set in one place, `metrics()` below.',
  }),
  Object.freeze({
    id: 'ESC-2',
    status: 'overruled',
    question:
      'What are a summary task’s LS/LF? FR-TSK-03 rolls up start/finish/duration and FR-SCH-05 defines float as LS - ES, but nothing defines a summary’s late dates.',
    adopted:
      'totalFloat = min(totalFloat over its DIRECT children); LS = ES + totalFloat and LF = EF + totalFloat, both shifted in working time. The early side is FR-TSK-03 unchanged: ES = min(child ES), EF = max(child EF). The corpus originally took LS = min(child LS) / LF = max(child LF); the tech-lead overruled it as a bug rather than a style choice, because a summary over children A(float 3) and B(float 0) then reports float 2 and is NOT flagged critical even though it spans the critical child B — leaving FR-SCH-10 drawing a critical path with a hole in it. The replacement is self-consistent by construction (float === LS - ES exactly) and propagates criticality upward.',
    affects: 'F07 (parent t1), F17 (all three summary levels).',
  }),
  Object.freeze({
    id: 'ESC-3',
    status: 'resolved',
    question:
      'Where does a zero-duration task sit when its instant falls on a working-day boundary with working time on both sides — end of the previous day, or start of the next?',
    adopted:
      'The start of the next: `addWorkingHours(t, 0, calendar)` (`../../calendar.ts`, merged in W2-1) already snaps forward to the earliest working instant at or after the candidate, and W3-1 places a milestone by calling that primitive rather than by inventing a second rule for zero durations. So the question was never open once the calendar kernel existed — it only looked open because the corpus was reasoning from the FRS text alone.',
    affects:
      'no fixture. F18 keeps its milestones at interior working hours or at the project start because it tests FR-TSK-04’s "no accumulated span", not the seam.',
  }),
  Object.freeze({
    id: 'ESC-4',
    status: 'overruled',
    question:
      'Is a task with NEGATIVE total float on the critical path? FR-SCH-05 and taskScheduleComputedSchema both said literally "float === 0"; conventional CPM treats float <= 0 as critical, which is also the only reading that keeps the critical path a connected chain on an over-constrained project.',
    adopted:
      'isCritical === (totalFloatHours <= 0). The contract text was the thing that was wrong: docs/FRS.md v1.2 tightens FR-SCH-05 to "Float <= 0" and `taskScheduleComputedSchema.isCritical` (packages/shared-types/src/schedule.ts) now documents it. Derived in `taskSchedule()` below, so no fixture states the flag by hand.',
    affects:
      'F12 (SNLT violated) — both tasks carry float -8 and are now critical. Every other fixture is unaffected: no other expectation in the corpus has negative float.',
  }),
  Object.freeze({
    id: 'ESC-5',
    status: 'ratified',
    question:
      'What does ALAP (FR-TSK-06) change — the persisted start/finish, or the computed ES/EF?',
    adopted:
      'The persisted dates only: start = LS and finish = LF, while earlyStart/earlyFinish keep reporting the early dates, so totalFloatHours stays LS - ES. This mirrors the split cpm.ts already specifies for a manual task ("start/finish are the user’s fixed dates while ES/EF still report where the graph would have put it").',
    affects: 'F15, unchanged.',
  }),
  Object.freeze({
    id: 'ESC-6',
    status: 'ruled',
    question:
      'Do successors of a MANUAL task schedule from the manual finish, or from the graph-implied earlyFinish the manual task would have had?',
    adopted:
      'From the manual finish — the manual dates are the real commitment, and a successor that scheduled off the graph-implied early finish instead would make manual mode meaningless for anything downstream. The manual task’s own earlyStart/earlyFinish keep reporting where the graph would have put it (cpm.ts), so the two readings are visibly different numbers on the same row.',
    affects:
      'F20, added to pin it. F07 and F08 could not: F07’s manual dates coincide with the graph-implied ones and F08’s manual task has no successor, so neither discriminates.',
  }),
]);

// ---------------------------------------------------------------------------------------------
// The shared working-time frame
// ---------------------------------------------------------------------------------------------

/** Monday, at the first working minute of the standard calendar. See the header's day table. */
export const PROJECT_START = '2026-09-07T08:00:00.000Z';

export const GOLDEN_PROJECT_ID = projectId(1);

/** Mon-Fri 08:00-16:00 UTC, no exceptions: 8 working hours per day. */
export const STANDARD_CALENDAR_ID = calendarId(1);

/** Mon-Fri 08:00-16:00 UTC plus a holiday and a half-day. Used only by F16. */
export const EXCEPTION_CALENDAR_ID = calendarId(2);

export function standardCalendar(): CpmCalendar {
  return {
    id: STANDARD_CALENDAR_ID,
    workingDays: [1, 2, 3, 4, 5],
    workingHoursStartMinute: 480,
    workingHoursEndMinute: 960,
    exceptions: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Builders — noise reduction only. Every date literal still appears at the fixture's call site.
// ---------------------------------------------------------------------------------------------

export interface ScheduleInputParts {
  readonly tasks: readonly CpmTask[];
  readonly dependencies: readonly CpmDependency[];
  /** Defaults to `[standardCalendar()]`. */
  readonly calendars?: readonly CpmCalendar[];
  /** Defaults to `STANDARD_CALENDAR_ID`. */
  readonly defaultCalendarId?: CpmScheduleInput['defaultCalendarId'];
}

export function scheduleInput(parts: ScheduleInputParts): CpmScheduleInput {
  return {
    projectId: GOLDEN_PROJECT_ID,
    projectStart: PROJECT_START,
    direction: 'forward',
    defaultCalendarId: parts.defaultCalendarId ?? STANDARD_CALENDAR_ID,
    calendars: [...(parts.calendars ?? [standardCalendar()])],
    tasks: [...parts.tasks],
    dependencies: [...parts.dependencies],
  };
}

export interface TaskScheduleParts {
  /** `earlyStart`. */
  readonly es: IsoDateTime;
  /** `earlyFinish`. */
  readonly ef: IsoDateTime;
  /** `lateStart`. */
  readonly ls: IsoDateTime;
  /** `lateFinish`. */
  readonly lf: IsoDateTime;
  /** FR-SCH-05: LS - ES **in working hours**, which is what the fixture's comment derives. */
  readonly floatHours: number;
  /** Persisted `task.start`. Defaults to `es` — differs only for manual (FR-TSK-05) and ALAP. */
  readonly start?: IsoDateTime;
  /** Persisted `task.finish`. Defaults to `ef`. */
  readonly finish?: IsoDateTime;
  /** Persisted `task.duration_hours`. For a summary, the working-hour span of its children. */
  readonly durationHours: number;
  /** FR-SCH-08 / FR-TSK-06. Defaults to false. */
  readonly conflict?: boolean;
}

/**
 * One row of `taskSchedules`. `isCritical` is **derived here** rather than passed, because
 * FR-SCH-05 (docs/FRS.md v1.2) defines it as `float <= 0` and a fixture that could state a
 * different answer would be able to encode a self-inconsistent expectation. ESC-4 is where that
 * `<= 0` — rather than the `=== 0` this corpus first wrote — was ruled on; because the flag is
 * derived, applying the ruling was this one line and no fixture had to be hand-edited.
 */
export function taskSchedule(n: number, parts: TaskScheduleParts): CpmTaskSchedule {
  return {
    taskId: taskId(n),
    earlyStart: parts.es,
    earlyFinish: parts.ef,
    lateStart: parts.ls,
    lateFinish: parts.lf,
    totalFloatHours: parts.floatHours,
    isCritical: parts.floatHours <= 0,
    hasScheduleConflict: parts.conflict ?? false,
    start: parts.start ?? parts.es,
    finish: parts.finish ?? parts.ef,
    durationHours: parts.durationHours,
  };
}

export interface MetricsParts {
  /** Every task in the input, summary tasks included. */
  readonly tasks: number;
  /** Structurally valid edges — the ones `buildGraph` keeps. */
  readonly edges: number;
  /** Longest chain in nodes, as `topological-order.ts` already defines it: 1 for a source task. */
  readonly depth: number;
}

/**
 * `CpmMetrics`, with **ESC-1's convention applied in exactly one place**. The tech-lead ratified
 * once-per-pass, so the line below stands; had it gone the other way this line would have changed
 * and no fixture would have — which is why it is a helper and not 20 literals.
 */
export function metrics(parts: MetricsParts): CpmMetrics {
  return {
    tasksScheduled: parts.tasks,
    dependenciesTraversed: parts.edges * 2,
    topologicalDepth: parts.depth,
  };
}

export interface ScheduledParts {
  readonly taskSchedules: readonly CpmTaskSchedule[];
  /** Ascending by `dependencyId` (the canonical order `cpm.ts` specifies). */
  readonly criticalDependencyIds: readonly DependencyId[];
  /** `max(earlyFinish)` — the contract's words, so this is not an interpretation. */
  readonly projectFinish: IsoDateTime;
  /** Warnings only. Defaults to `[]`. */
  readonly diagnostics?: readonly CpmDiagnostic[];
  readonly metrics: CpmMetrics;
}

export function scheduled(parts: ScheduledParts): CpmScheduledResult {
  return {
    status: 'scheduled',
    projectId: GOLDEN_PROJECT_ID,
    taskSchedules: [...parts.taskSchedules],
    criticalDependencyIds: [...parts.criticalDependencyIds],
    projectFinish: parts.projectFinish,
    diagnostics: [...(parts.diagnostics ?? [])],
    metrics: parts.metrics,
  };
}

export function rejected(diagnostics: readonly CpmDiagnostic[]): CpmScheduleResult {
  return { status: 'rejected', projectId: GOLDEN_PROJECT_ID, diagnostics: [...diagnostics] };
}

// ---------------------------------------------------------------------------------------------
// The corpus entry shape
// ---------------------------------------------------------------------------------------------

export interface GoldenFixture {
  /** Stable, sortable, and quotable in a bug report: `F01-fs-chain`. */
  readonly id: string;
  /** One line: what a failure of this fixture would mean. */
  readonly proves: string;
  /** The `FR-*` ids this fixture is evidence for. */
  readonly requirements: readonly string[];
  readonly input: CpmScheduleInput;
  readonly expected: CpmScheduleResult;
}
