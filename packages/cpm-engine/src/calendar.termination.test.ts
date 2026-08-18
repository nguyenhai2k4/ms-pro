import { describe, expect, it } from 'vitest';
import type { WorkingTimeCalendar } from './calendar.js';
import { addWorkingHours, compileCalendar, workingHoursBetween } from './calendar.js';
import { calendarId, makeCalendar } from './test-support/calendars.js';

/**
 * Acceptance (f) — a calendar with no working time is reported, and the walk terminates.
 *
 * `cpmCalendarSchema` deliberately permits `workingDays: []` ("a calendar with no working days is
 * reachable through FR-CAL-01's editing endpoint, and an engine that threw on it would turn a
 * user's bad input into a 500"). "Advance to the next working minute" on such a calendar has no
 * answer, so an implementation that reached for one would spin forever — the classic way a pure
 * function becomes a production incident.
 *
 * ## Why the guard is structural, and what the timeout is actually worth
 *
 * A synchronous infinite loop cannot be interrupted by a test timeout: the loop never yields, so
 * vitest's timer never runs and the whole suite hangs instead of failing. The `5_000` argument on
 * each case below is therefore a backstop and a statement of intent, **not** the mechanism. The
 * mechanism is two structural layers, both asserted here:
 *
 *  1. `compileCalendar` refuses to produce a `WorkingTimeCalendar` at all, so no walk can be
 *     handed one. Every kernel function takes the compiled type, which makes the non-terminating
 *     input *unrepresentable* rather than merely checked-for.
 *  2. Should a future refactor smuggle one past layer 1 — the case the third test forges by hand —
 *     the walk's `maxConsecutiveIdleDays` invariant throws after a bounded number of day steps
 *     instead of looping. A usable calendar has a working day every 7 days plus at most one
 *     exception-shaped hole, so the bound can never fire on real input.
 *
 * The elapsed-time assertions make the "it returned quickly" claim explicit rather than implicit.
 * `Date.now()` is banned in engine `src/` and allowed here — timing from outside is exactly how
 * `cpm.ts` says the engine must be measured ("there is also no `elapsedMs` anywhere in the
 * result").
 */

const UNUSABLE_CASES = [
  {
    what: 'no working days at all',
    calendar: makeCalendar({ id: calendarId(20), workingDays: [] }),
  },
  {
    what: 'a window that ends when it starts',
    calendar: makeCalendar({
      id: calendarId(21),
      workingHoursStartMinute: 9 * 60,
      workingHoursEndMinute: 9 * 60,
    }),
  },
  {
    what: 'a window that ends before it starts',
    calendar: makeCalendar({
      id: calendarId(22),
      workingHoursStartMinute: 17 * 60,
      workingHoursEndMinute: 9 * 60,
    }),
  },
  {
    what: 'no working days, but exceptions that make a few dates working',
    // Exceptions cannot rescue it: there are finitely many, so past the last one the search for
    // "the next working instant" would never end. Usability that depended on which date was asked
    // about would make termination a property of the query rather than of the input.
    calendar: makeCalendar({
      id: calendarId(23),
      workingDays: [],
      exceptions: [
        { date: '2026-12-01', isWorking: true, startMinuteOverride: 540, endMinuteOverride: 1020 },
      ],
    }),
  },
] as const;

describe('compileCalendar — acceptance (f): unusable_calendar, reported and terminating', () => {
  it.each(UNUSABLE_CASES)(
    'reports unusable_calendar for a calendar with $what, and returns immediately',
    ({ calendar }) => {
      const startedAt = Date.now();
      const compiled = compileCalendar(calendar);
      const elapsedMs = Date.now() - startedAt;

      expect(compiled).toEqual({
        status: 'unusable',
        diagnostic: {
          code: 'unusable_calendar',
          severity: 'error',
          calendarId: calendar.id,
        },
      });
      expect(elapsedMs).toBeLessThan(1_000);
    },
    5_000,
  );

  it('compiles a calendar that keeps one working day a week — the boundary of usable', () => {
    const compiled = compileCalendar(makeCalendar({ id: calendarId(24), workingDays: [7] }));
    expect(compiled.status).toBe('usable');
  }, 5_000);

  it('still terminates if an unusable calendar is forged past compileCalendar', () => {
    // Layer 2. This object cannot come out of `compileCalendar`; it is built by hand precisely to
    // exercise the guard that would catch a future refactor which let one through. The walk must
    // *throw an engine invariant* — loudly, in bounded time — not spin.
    const forged: WorkingTimeCalendar = {
      id: calendarId(25),
      weeklyWindows: [null, null, null, null, null, null, null, null],
      patternWindowMs: 0,
      patternDaysPerWeek: 0,
      weekPrefix: [0, 0, 0, 0, 0, 0, 0, 0],
      exceptionDays: [],
      exceptionWindows: [],
      exceptionDeltaPrefix: [0],
      maxConsecutiveIdleDays: 14,
    };

    const startedAt = Date.now();
    expect(() => addWorkingHours(0, 8, forged)).toThrow(/cpm-engine invariant/);
    expect(() => addWorkingHours(0, -8, forged)).toThrow(/cpm-engine invariant/);
    expect(() => addWorkingHours(0, 0, forged)).toThrow(/cpm-engine invariant/);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    // Measuring a span needs no search, so it stays total even on a calendar with no working
    // time: the answer is simply zero.
    expect(workingHoursBetween(0, 10_000_000_000, forged)).toBe(0);
  }, 5_000);
});

describe('addWorkingHours — a non-finite duration is rejected, not looped on', () => {
  it('throws rather than spinning on Infinity or NaN', () => {
    const compiled = compileCalendar(makeCalendar({ id: calendarId(26) }));
    if (compiled.status !== 'usable') expect.unreachable('fixture calendar must compile');

    // `durationHoursSchema` and `lagHoursSchema` are both `.finite()`, so reaching this is a caller
    // that skipped validation. It is the one caller-shaped input that would make the walk
    // non-terminating, which is why it is checked at all.
    expect(() => addWorkingHours(0, Number.POSITIVE_INFINITY, compiled.calendar)).toThrow(
      /cpm-engine invariant/,
    );
    expect(() => addWorkingHours(0, Number.NaN, compiled.calendar)).toThrow(/cpm-engine invariant/);
  });
});
