import type { CpmCalendar, CpmCalendarException } from '@projectapp/shared-types';
import type { CpmUnusableCalendarDiagnostic } from './diagnostics.js';
import { at, invariant } from './invariant.js';
import { compareIds, compareNumbers } from './ordering.js';
import type { UtcDayNumber, UtcInstant } from './instant.js';
import {
  MINUTES_PER_DAY,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  floorDiv,
  isoWeekdayOfDay,
  parseIsoDate,
  startOfUtcDay,
  utcDayNumber,
} from './instant.js';

/**
 * The working-time kernel (FR-SCH-07, FR-CAL-01/02, FR-TSK-04/07; ADR-011).
 *
 * Every CPM pass converts between a *duration in working hours* and an *instant on the timeline*.
 * That conversion is the whole of this file, and it is deliberately the only place in the engine
 * that knows a weekend exists — the forward pass, the backward pass, lag application and float all
 * call `addWorkingHours` / `workingHoursBetween` rather than re-deriving "skip Saturday" five
 * times, five subtly different ways.
 *
 * ## The model: working time is a measure on the timeline
 *
 * Each UTC date contributes at most one half-open working interval `[start, end)`, taken from an
 * exception if the date has one and from the weekly pattern otherwise. Define
 *
 *     W(t) = the number of working milliseconds strictly before t
 *
 * — a non-decreasing step function, constant across nights and weekends. Then the two public
 * primitives are just the two directions of the same relationship:
 *
 *  - `workingMillisecondsBetween(a, b) = W(b) - W(a)`  (signed; negative when `b < a`)
 *  - `addWorkingHours(t, h)` = the **earliest** instant `u >= t` with `W(u) = W(t) + h`
 *
 * "Earliest" is doing real work in that second definition. `W` is flat across a non-working gap, so
 * a whole range of instants share the same working-time coordinate; picking the earliest is what
 * makes a 4-hour task starting Friday 13:00 on a 09:00-17:00 calendar finish at **Friday 17:00**
 * rather than at Monday 09:00. It is also what makes the round-trip property
 * `workingHoursBetween(t, addWorkingHours(t, h)) === h` hold for *every* `t`, including a `t` in
 * the middle of a weekend: no working time lies between a non-working `t` and the next working
 * instant, so snapping forward costs nothing in `W`.
 *
 * The mirror image is the one asymmetry worth stating plainly, because a test will trip over it:
 * walking back `h` hours and then forward `h` hours returns the *earliest* representative of `t`'s
 * working-time coordinate. For any `t` strictly inside a working interval that is `t` itself; for a
 * `t` sitting exactly on a day's opening minute it is the previous day's closing minute, which is
 * the same instant in working time and a different instant on the wall clock. See
 * `addWorkingHours`.
 *
 * ## Milestones (FR-TSK-04)
 *
 * `addWorkingHours(t, 0)` snaps **forward** to the next working instant and stops. A zero-duration
 * milestone landing at 02:00 on a Saturday is reported at Monday 09:00, which is when it can
 * actually occur. Falling out of the general definition rather than being special-cased is the
 * point: there is no separate milestone code path to drift.
 *
 * ## Negative durations (FR-SCH-02 lead)
 *
 * Negative lag walks the same intervals in the opposite direction inside `addWorkingHours`. There
 * is deliberately no second function — two implementations of "skip non-working time" is exactly
 * how a lead of -8h stops agreeing with a lag of +8h.
 *
 * ## Termination (`unusable_calendar`)
 *
 * "Advance to the next working instant" cannot terminate on a calendar that has no recurring
 * working time, so such a calendar never reaches the walk: `compileCalendar` refuses to produce a
 * `WorkingTimeCalendar` for it and returns the `unusable_calendar` diagnostic instead. Every
 * function here takes the compiled type, so the non-terminating case is not merely guarded against
 * — it is unrepresentable. See `compileCalendar` for what "no recurring working time" means and why
 * exceptions cannot rescue it.
 */

// ---------------------------------------------------------------------------------------------
// Compiled calendar
// ---------------------------------------------------------------------------------------------

/** A single day's working interval, as milliseconds from midnight UTC. Half-open, `0 <= start < end <= MS_PER_DAY`. */
export interface WorkingWindow {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A `CpmCalendar` compiled into the shape the walk actually needs: the weekly pattern indexed by
 * ISO weekday, exceptions indexed by day number, and a prefix sum that turns "how much working time
 * is there before this date" into O(log exceptions) instead of a day-by-day scan.
 *
 * Compiling is not an optimisation detail, it is where the input is *validated once*. A calendar
 * that reached the walk uncompiled would have to re-derive "is this a working weekday", re-parse an
 * exception's `YYYY-MM-DD`, and re-check for the no-working-days case on every single day step —
 * and the last of those is a termination condition, not a performance one.
 *
 * Treat as opaque: the fields are readable for tests and debugging, and nothing outside this file
 * constructs one.
 */
export interface WorkingTimeCalendar {
  readonly id: CpmCalendar['id'];
  /** Indexed by ISO weekday 1-7; index 0 is unused padding. `null` = not a working day. */
  readonly weeklyWindows: readonly (WorkingWindow | null)[];
  /** Length of the weekly window in ms. Always > 0 — a zero-length one makes the calendar unusable. */
  readonly patternWindowMs: number;
  /** How many of the 7 weekdays are working days. Always >= 1. */
  readonly patternDaysPerWeek: number;
  /** `weekPrefix[k]` = working days among the first `k` offsets of an epoch-aligned week. Length 8. */
  readonly weekPrefix: readonly number[];
  /** Exception day numbers, ascending, deduplicated. Parallel to `exceptionWindows`. */
  readonly exceptionDays: readonly UtcDayNumber[];
  /** The effective window for `exceptionDays[i]`; `null` for a full-day non-working exception. */
  readonly exceptionWindows: readonly (WorkingWindow | null)[];
  /** `exceptionDeltaPrefix[i]` = summed (exception ms - pattern ms) over `exceptionDays[0..i)`. */
  readonly exceptionDeltaPrefix: readonly number[];
  /** See `compileCalendar` — the provable upper bound on consecutive non-working days. */
  readonly maxConsecutiveIdleDays: number;
}

/**
 * The result of compiling. A status union rather than "returns null" or "throws" for the same
 * reason `topologicalOrder` returns one: the failure is a *diagnostic the caller must surface*
 * (`cpm.ts`'s `unusable_calendar`, an error severity that rejects the computation), not an
 * exception, and not something a caller can forget to check without the compiler noticing.
 */
export type CompiledCalendar =
  | { readonly status: 'usable'; readonly calendar: WorkingTimeCalendar }
  | { readonly status: 'unusable'; readonly diagnostic: CpmUnusableCalendarDiagnostic };

/**
 * Compiles a contract calendar into the kernel's form, or reports why it cannot be used.
 *
 * **Pure**: the input is read, never mutated, and the result depends only on the *set* of
 * exceptions, never on the order the array arrived in (duplicates on the same date resolve
 * first-wins after an explicit total-order sort — the same rule `buildGraph` applies to duplicate
 * primary keys, and for the same determinism reason).
 *
 * ## What makes a calendar unusable
 *
 * A calendar is unusable when its **weekly pattern** contributes no working time — either
 * `workingDays` is empty, or the window is empty (`end <= start`). `cpmCalendarSchema` permits both
 * (the first explicitly: an empty `workingDays` is reachable through FR-CAL-01's editing endpoint,
 * and the DB's `working_hours_end_minute > working_hours_start_minute` check does not cover an
 * exception's overrides), so this is real input, not a hypothetical.
 *
 * Exceptions cannot rescue such a calendar. There are finitely many of them, so past the last one
 * there is no working time left at all and "advance to the next working instant" would search
 * forever. Accepting a calendar whose usability depended on *which dates were asked about* would
 * make termination a property of the query rather than of the input, which is not a property one
 * can test.
 *
 * ## Why the walk provably terminates once this returns `usable`
 *
 * A usable calendar has at least one working weekday and a window of positive length, so **every 7
 * consecutive days contain at least one day the pattern makes working**. The only thing that can
 * take such a day away is an exception (`isWorking: false`, or an override collapsing the window),
 * and there are `exceptionDays.length` of those in total. So a run of consecutive non-working days
 * can span at most `7 * (exceptions + 1)` days; `maxConsecutiveIdleDays` records that bound with a
 * week of slack, and the walk asserts against it. Reaching it is an engine bug — which is exactly
 * what `invariant.ts` is for — rather than bad input, because bad input was rejected here.
 */
export function compileCalendar(source: CpmCalendar): CompiledCalendar {
  const patternStartMinute = source.workingHoursStartMinute;
  const patternEndMinute = source.workingHoursEndMinute;
  const patternWindow = windowFromMinutes(patternStartMinute, patternEndMinute);

  const workingWeekdays = new Set<number>();
  for (const weekday of source.workingDays) {
    if (Number.isInteger(weekday) && weekday >= 1 && weekday <= 7) workingWeekdays.add(weekday);
  }

  if (patternWindow === null || workingWeekdays.size === 0) {
    return {
      status: 'unusable',
      diagnostic: { code: 'unusable_calendar', severity: 'error', calendarId: source.id },
    };
  }

  const weeklyWindows: (WorkingWindow | null)[] = [null, null, null, null, null, null, null, null];
  for (const weekday of workingWeekdays) weeklyWindows[weekday] = patternWindow;

  // `weekPrefix[k]` counts working days among day numbers `0..k-1`, which — because day 0 is a
  // Thursday and every week is 7 days — is the same count as among offsets `0..k-1` of *any*
  // epoch-aligned week. That is what makes `patternWorkingDaysBefore` a closed form.
  const weekPrefix: number[] = [0];
  for (let offset = 0; offset < 7; offset += 1) {
    const working = weeklyWindows[isoWeekdayOfDay(offset)] ?? null;
    weekPrefix.push(at(weekPrefix, offset) + (working === null ? 0 : 1));
  }

  // Exceptions: canonical order first, then first-wins per date. The DB has UNIQUE (calendar_id,
  // date), so a duplicate is a caller bug — but resolving it by "whichever the array listed first"
  // would make the compiled calendar depend on input order, and determinism is not negotiable.
  const sorted = [...source.exceptions].sort(compareExceptions);
  const exceptionDays: UtcDayNumber[] = [];
  const exceptionWindows: (WorkingWindow | null)[] = [];
  const exceptionDeltaPrefix: number[] = [0];
  let previousDay: UtcDayNumber | null = null;

  for (const exception of sorted) {
    // An unparseable date cannot come from the loader (`calendar_exception.date` is a `date`
    // column, serialised as YYYY-MM-DD) and `isoDateSchema` rejects the shape. There is no
    // diagnostic code for "malformed exception date" in `cpm.ts`, and inventing a meaning for an
    // existing code is worse than ignoring a row the database cannot produce — so it is skipped.
    // If this ever becomes reachable it is a shared-types change and a tech-lead call
    // (CLAUDE.md invariant 7), not something to decide here.
    const day = parseIsoDate(exception.date);
    if (day === null) continue;
    if (previousDay !== null && day === previousDay) continue;
    previousDay = day;

    const window = effectiveExceptionWindow(exception, patternStartMinute, patternEndMinute);
    const displaced = weeklyWindows[isoWeekdayOfDay(day)] ?? null;
    const patternMs = displaced === null ? 0 : displaced.endMs - displaced.startMs;
    const exceptionMs = window === null ? 0 : window.endMs - window.startMs;

    exceptionDays.push(day);
    exceptionWindows.push(window);
    exceptionDeltaPrefix.push(
      at(exceptionDeltaPrefix, exceptionDeltaPrefix.length - 1) + exceptionMs - patternMs,
    );
  }

  return {
    status: 'usable',
    calendar: {
      id: source.id,
      weeklyWindows,
      patternWindowMs: patternWindow.endMs - patternWindow.startMs,
      patternDaysPerWeek: workingWeekdays.size,
      weekPrefix,
      exceptionDays,
      exceptionWindows,
      exceptionDeltaPrefix,
      maxConsecutiveIdleDays: 7 * (exceptionDays.length + 2),
    },
  };
}

/**
 * FR-CAL-02. An exception replaces the weekly pattern for its date:
 *
 *  - `isWorking: false` — a holiday. The date has no working time at all, whatever the weekly
 *    pattern says.
 *  - `isWorking: true` — a working date, *even if its weekday is not a working day* (a rescheduled
 *    Saturday is the whole reason the flag is not simply "holiday"). Each override that is present
 *    replaces that end of the window; an absent one falls back to the weekly value, which is what
 *    makes a half-day expressible as a single `endMinuteOverride`.
 *
 * A window that ends at or before it starts is no working time. The DB constrains the weekly
 * columns that way but not the override columns, so `09:00-09:00` is reachable input rather than a
 * hypothetical.
 */
function effectiveExceptionWindow(
  exception: CpmCalendarException,
  patternStartMinute: number,
  patternEndMinute: number,
): WorkingWindow | null {
  if (!exception.isWorking) return null;
  return windowFromMinutes(
    exception.startMinuteOverride ?? patternStartMinute,
    exception.endMinuteOverride ?? patternEndMinute,
  );
}

/** Minutes from midnight UTC (ADR-011) -> a within-day ms window, or `null` when it is empty. */
function windowFromMinutes(startMinute: number, endMinute: number): WorkingWindow | null {
  const start = clampMinute(startMinute);
  const end = clampMinute(endMinute);
  if (end <= start) return null;
  return { startMs: start * MS_PER_MINUTE, endMs: end * MS_PER_MINUTE };
}

function clampMinute(minute: number): number {
  if (!Number.isFinite(minute)) return 0;
  return Math.min(Math.max(Math.trunc(minute), 0), MINUTES_PER_DAY);
}

/** A total order on exceptions: by date, then by every remaining field. See `ordering.ts` rule 2. */
function compareExceptions(a: CpmCalendarException, b: CpmCalendarException): number {
  return (
    compareIds(a.date, b.date) ||
    compareNumbers(a.isWorking ? 1 : 0, b.isWorking ? 1 : 0) ||
    compareNumbers(a.startMinuteOverride ?? -1, b.startMinuteOverride ?? -1) ||
    compareNumbers(a.endMinuteOverride ?? -1, b.endMinuteOverride ?? -1)
  );
}

// ---------------------------------------------------------------------------------------------
// Day lookup
// ---------------------------------------------------------------------------------------------

/**
 * The effective working window for one UTC date: the exception's if the date has one, the weekly
 * pattern's otherwise, `null` when the date is not a working date at all.
 *
 * Exported because the passes need it directly — snapping a constraint date to a day boundary, and
 * FR-SCH-08's "what would this manual task's dates have been" both ask this question without
 * wanting to move anything.
 */
export function workingWindowOnDay(
  calendar: WorkingTimeCalendar,
  day: UtcDayNumber,
): WorkingWindow | null {
  const index = exceptionIndexOf(calendar, day);
  if (index >= 0) return at(calendar.exceptionWindows, index);
  return calendar.weeklyWindows[isoWeekdayOfDay(day)] ?? null;
}

/** Index of `day` in `exceptionDays`, or -1. Binary search — the array is ascending by construction. */
function exceptionIndexOf(calendar: WorkingTimeCalendar, day: UtcDayNumber): number {
  const days = calendar.exceptionDays;
  let low = 0;
  let high = days.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = at(days, mid);
    if (value === day) return mid;
    if (value < day) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/** How many exception dates fall strictly before `day`. The insertion point for `day`. */
function exceptionsBefore(calendar: WorkingTimeCalendar, day: UtcDayNumber): number {
  const days = calendar.exceptionDays;
  let low = 0;
  let high = days.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (at(days, mid) < day) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---------------------------------------------------------------------------------------------
// The public primitives
// ---------------------------------------------------------------------------------------------

/**
 * FR-SCH-07. Is this UTC instant inside working time?
 *
 * Half-open: a day's closing instant is **not** working. Without that, 17:00 would count as working
 * on a 09:00-17:00 calendar and an 8-hour task starting at 09:00 would be reported as still
 * running when it has finished — and the two adjacent windows of a round-the-clock calendar would
 * double-count their shared boundary.
 */
export function isWorkingInstant(instant: UtcInstant, calendar: WorkingTimeCalendar): boolean {
  const day = utcDayNumber(instant);
  const window = workingWindowOnDay(calendar, day);
  if (window === null) return false;
  const msOfDay = instant - startOfUtcDay(day);
  return msOfDay >= window.startMs && msOfDay < window.endMs;
}

/**
 * The earliest working instant at or after `instant` — `instant` itself when it is already working.
 *
 * This is FR-TSK-04's milestone rule (`addWorkingHours(t, 0)` is exactly this call) and the start
 * of every forward duration conversion. It is one function so the two can never disagree.
 */
export function nextWorkingInstant(instant: UtcInstant, calendar: WorkingTimeCalendar): UtcInstant {
  return addWorkingMilliseconds(instant, 0, calendar);
}

/**
 * FR-SCH-07 / FR-SCH-02. Advance `start` by `hours` of **working** time, skipping non-working
 * minutes; a negative `hours` (a lead) retreats by the same rule.
 *
 * Hours are converted to whole milliseconds by `Math.round`, so a duration finer than a millisecond
 * is not representable. That is deliberate and it is what keeps every instant in the engine an
 * integer: a fractional-millisecond finish would print differently after a round trip through the
 * database, and "byte-identical output" would quietly stop being true.
 *
 * ## What is guaranteed
 *
 *  - `workingHoursBetween(t, addWorkingHours(t, h, cal)) === h` for every `t` and every `h >= 0`.
 *  - `workingHoursBetween(addWorkingHours(t, -h, cal), t, cal) === h` for every `t` and `h >= 0`.
 *  - `addWorkingHours(t, 0, cal)` is the next working instant `>= t` (FR-TSK-04).
 *
 * ## What is *not* guaranteed, and why
 *
 * `addWorkingHours(addWorkingHours(t, -h), h) === t` holds whenever `t` lies strictly inside a
 * working interval, which is where a scheduled date always lands. It does **not** hold when `t` is
 * the opening instant of a working day that follows a gap: going back and forward again returns
 * the *previous* day's closing instant, which is the same point in working time (`W` is equal at
 * both) and the earlier of the two representatives. Forward conversion always returns the earliest
 * representative — that is what makes a task ending exactly at close-of-business finish at 17:00
 * rather than at 09:00 the next morning — and no total function can return both. Callers that need
 * a canonical form should compare with `workingHoursBetween(a, b) === 0` rather than `a === b`.
 */
export function addWorkingHours(
  start: UtcInstant,
  hours: number,
  calendar: WorkingTimeCalendar,
): UtcInstant {
  invariant(
    Number.isFinite(hours),
    `addWorkingHours received a non-finite duration (${hours}); durationHoursSchema and lagHoursSchema both require finite`,
  );
  return addWorkingMilliseconds(start, Math.round(hours * MS_PER_HOUR), calendar);
}

/**
 * `addWorkingHours` in exact milliseconds. The passes use this for anything they intend to compare
 * for equality; going through hours and back would introduce a float round trip for no reason.
 */
export function addWorkingMilliseconds(
  start: UtcInstant,
  milliseconds: number,
  calendar: WorkingTimeCalendar,
): UtcInstant {
  invariant(
    Number.isFinite(start) && Number.isFinite(milliseconds),
    `addWorkingMilliseconds received a non-finite argument (start=${start}, milliseconds=${milliseconds})`,
  );
  return milliseconds < 0
    ? retreat(start, -milliseconds, calendar)
    : advance(start, milliseconds, calendar);
}

/**
 * Forward walk. `remaining === 0` falls through to the snap-forward case naturally: the first day
 * with any window at or after the cursor returns its own opening instant, which is what a milestone
 * needs (FR-TSK-04).
 */
function advance(
  start: UtcInstant,
  remainingMs: number,
  calendar: WorkingTimeCalendar,
): UtcInstant {
  let day = utcDayNumber(start);
  let msOfDay = start - startOfUtcDay(day);
  let remaining = remainingMs;
  let idleDays = 0;

  for (;;) {
    const window = workingWindowOnDay(calendar, day);
    if (window !== null && msOfDay < window.endMs) {
      const cursor = Math.max(msOfDay, window.startMs);
      const available = window.endMs - cursor;
      if (remaining <= available) return startOfUtcDay(day) + cursor + remaining;
      remaining -= available;
      idleDays = 0;
    } else {
      idleDays += 1;
      invariant(
        idleDays <= calendar.maxConsecutiveIdleDays,
        `advanced ${idleDays} days through calendar ${calendar.id} without finding working time; a usable calendar has a working day every 7 days plus at most one per exception`,
      );
    }
    day += 1;
    msOfDay = 0;
  }
}

/**
 * Backward walk — the mirror of `advance`, sharing its interval model rather than reimplementing
 * it. A cursor sitting exactly on a day's opening instant has no working time behind it *on that
 * day*, so the walk steps to the previous day; that is the boundary case documented on
 * `addWorkingHours`.
 */
function retreat(
  start: UtcInstant,
  remainingMs: number,
  calendar: WorkingTimeCalendar,
): UtcInstant {
  let day = utcDayNumber(start);
  let msOfDay = start - startOfUtcDay(day);
  let remaining = remainingMs;
  let idleDays = 0;

  for (;;) {
    const window = workingWindowOnDay(calendar, day);
    if (window !== null && msOfDay > window.startMs) {
      const cursor = Math.min(msOfDay, window.endMs);
      const available = cursor - window.startMs;
      if (remaining <= available) return startOfUtcDay(day) + cursor - remaining;
      remaining -= available;
      idleDays = 0;
    } else {
      idleDays += 1;
      invariant(
        idleDays <= calendar.maxConsecutiveIdleDays,
        `retreated ${idleDays} days through calendar ${calendar.id} without finding working time; a usable calendar has a working day every 7 days plus at most one per exception`,
      );
    }
    day -= 1;
    msOfDay = MS_PER_DAY;
  }
}

/**
 * FR-SCH-07. Working hours between two instants — the inverse of `addWorkingHours`, and what total
 * float (LS - ES) is measured in.
 *
 * **Signed**: `end < start` gives a negative result. Float is allowed to go negative when a hard
 * constraint cannot be met (`cpm.ts`'s `constraint_violation` says so explicitly), and a function
 * that returned a magnitude would make that case unrepresentable rather than merely rare.
 *
 * Cost is O(log exceptions), not O(days between). It is a closed form over the weekly pattern plus
 * a prefix sum over the exceptions, so a float calculation spanning a two-year project costs the
 * same as one spanning an afternoon — which matters because the backward pass calls this once per
 * task and the budget is 500ms at 5,000 tasks.
 */
export function workingHoursBetween(
  start: UtcInstant,
  end: UtcInstant,
  calendar: WorkingTimeCalendar,
): number {
  return workingMillisecondsBetween(start, end, calendar) / MS_PER_HOUR;
}

/** `workingHoursBetween` in exact milliseconds — see `addWorkingMilliseconds` for why both exist. */
export function workingMillisecondsBetween(
  start: UtcInstant,
  end: UtcInstant,
  calendar: WorkingTimeCalendar,
): number {
  return workingMillisecondsBefore(end, calendar) - workingMillisecondsBefore(start, calendar);
}

/**
 * `W(t)`: working milliseconds strictly before `t`, counted from the epoch.
 *
 * Only differences of this are ever observed, so the origin is arbitrary — but it must be *fixed*,
 * because a relative implementation would have to walk from one instant to the other and the walk
 * is what the O(log) form exists to avoid. Three terms:
 *
 *  1. the weekly pattern's contribution over whole days before `t`, in closed form;
 *  2. a correction for every exception before `t` — its own working ms minus what the pattern would
 *     have contributed on that date — read off a prefix sum;
 *  3. the part of `t`'s own day that lies before `t`.
 */
function workingMillisecondsBefore(instant: UtcInstant, calendar: WorkingTimeCalendar): number {
  const day = utcDayNumber(instant);
  const msOfDay = instant - startOfUtcDay(day);

  const patternMs = patternWorkingDaysBefore(calendar, day) * calendar.patternWindowMs;
  const correctionMs = at(calendar.exceptionDeltaPrefix, exceptionsBefore(calendar, day));

  const window = workingWindowOnDay(calendar, day);
  const partialMs =
    window === null
      ? 0
      : Math.min(Math.max(msOfDay, window.startMs), window.endMs) - window.startMs;

  return patternMs + correctionMs + partialMs;
}

/**
 * Working days the weekly pattern puts strictly before day number `day`, counted from the epoch.
 * Signed, so it is correct for pre-epoch dates too: `floorDiv` rounds toward -infinity, and
 * `weekPrefix` is indexed by the matching non-negative remainder.
 */
function patternWorkingDaysBefore(calendar: WorkingTimeCalendar, day: UtcDayNumber): number {
  const weeks = floorDiv(day, 7);
  return weeks * calendar.patternDaysPerWeek + at(calendar.weekPrefix, day - weeks * 7);
}
