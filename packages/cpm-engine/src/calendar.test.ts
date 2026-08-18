import { describe, expect, it } from 'vitest';
import {
  addWorkingHours,
  isWorkingInstant,
  nextWorkingInstant,
  workingHoursBetween,
  workingWindowOnDay,
} from './calendar.js';
import { formatIsoDateTime, parseIsoDateTime, utcDayNumber } from './instant.js';
import {
  ALWAYS_WORKING,
  MON_FRI_9_TO_5,
  MON_FRI_WITH_EXCEPTIONS,
  WEDNESDAYS_ONLY,
  calendarId,
  halfDay,
  holiday,
  makeCalendar,
  usable,
} from './test-support/calendars.js';

/**
 * The working-time kernel's hand-verified cases (FR-SCH-07, FR-CAL-01/02, FR-TSK-04).
 *
 * Every expected value below is *walked out in a comment* rather than asserted as a bare number.
 * That is not decoration: a calendar bug produces a plausible-looking date, so a test whose
 * expectation was produced by running the code it tests would lock the bug in. If a comment and an
 * assertion ever disagree here, the comment is the specification.
 */

/** `at('2026-11-27T13:00Z')` — the seconds and milliseconds a test does not care about, implied. */
function at(iso: string): number {
  const full = /T\d{2}:\d{2}Z$/.test(iso) ? iso.replace(/Z$/, ':00.000Z') : iso;
  const parsed = parseIsoDateTime(full);
  if (parsed === null) throw new Error(`test fixture: ${iso} -> ${full} is not a valid instant`);
  return parsed;
}

/** Assertion helper that reports failures as readable ISO strings instead of epoch numbers. */
function expectInstant(actual: number): { toBe: (iso: string) => void } {
  return {
    toBe(iso: string) {
      expect(formatIsoDateTime(actual)).toBe(formatIsoDateTime(at(iso)));
    },
  };
}

const monFri = usable(MON_FRI_9_TO_5);
const withExceptions = usable(MON_FRI_WITH_EXCEPTIONS);
const alwaysWorking = usable(ALWAYS_WORKING);
const wednesdays = usable(WEDNESDAYS_ONLY);

// -----------------------------------------------------------------------------------------------
// isWorkingInstant (FR-SCH-07)
// -----------------------------------------------------------------------------------------------

describe('isWorkingInstant — the weekly pattern, read in UTC (ADR-011)', () => {
  it('accepts the working window and rejects the night around it', () => {
    // 2026-11-27 is a Friday. The calendar is Mon-Fri 09:00-17:00 UTC.
    expect(isWorkingInstant(at('2026-11-27T08:59Z'), monFri)).toBe(false);
    expect(isWorkingInstant(at('2026-11-27T09:00Z'), monFri)).toBe(true);
    expect(isWorkingInstant(at('2026-11-27T16:59Z'), monFri)).toBe(true);
    // Half-open: 17:00 is the instant the day *ends*, so it is not itself working.
    expect(isWorkingInstant(at('2026-11-27T17:00Z'), monFri)).toBe(false);
  });

  it('rejects the whole of a non-working weekday', () => {
    // 2026-11-28 Saturday, 2026-11-29 Sunday.
    expect(isWorkingInstant(at('2026-11-28T12:00Z'), monFri)).toBe(false);
    expect(isWorkingInstant(at('2026-11-29T12:00Z'), monFri)).toBe(false);
    expect(isWorkingInstant(at('2026-11-30T12:00Z'), monFri)).toBe(true); // Monday
  });

  it('treats a round-the-clock calendar as having no boundary between days', () => {
    expect(isWorkingInstant(at('2026-11-28T23:59Z'), alwaysWorking)).toBe(true);
    expect(isWorkingInstant(at('2026-11-29T00:00Z'), alwaysWorking)).toBe(true);
  });
});

describe('isWorkingInstant — exceptions override the weekly pattern (FR-CAL-02)', () => {
  it('removes a full-day exception from working time even on a working weekday', () => {
    // 2026-11-26 is a Thursday and a holiday in this calendar.
    expect(isWorkingInstant(at('2026-11-26T12:00Z'), monFri)).toBe(true);
    expect(isWorkingInstant(at('2026-11-26T12:00Z'), withExceptions)).toBe(false);
  });

  it('adds a working Saturday, which the weekly pattern alone could never express', () => {
    // 2026-11-28 is a Saturday with an `isWorking: true` exception and no overrides, so it takes
    // the weekly 09:00-17:00 window.
    expect(isWorkingInstant(at('2026-11-28T12:00Z'), withExceptions)).toBe(true);
    expect(isWorkingInstant(at('2026-11-28T08:00Z'), withExceptions)).toBe(false);
  });

  it('replaces the window on a half-day rather than intersecting with it', () => {
    // 2026-12-24: `endMinuteOverride` 13:00, no start override -> 09:00-13:00.
    expect(isWorkingInstant(at('2026-12-24T09:00Z'), withExceptions)).toBe(true);
    expect(isWorkingInstant(at('2026-12-24T12:59Z'), withExceptions)).toBe(true);
    expect(isWorkingInstant(at('2026-12-24T13:00Z'), withExceptions)).toBe(false);

    // 2026-12-28: `startMinuteOverride` 12:00, no end override -> 12:00-17:00.
    expect(isWorkingInstant(at('2026-12-28T11:59Z'), withExceptions)).toBe(false);
    expect(isWorkingInstant(at('2026-12-28T12:00Z'), withExceptions)).toBe(true);
    expect(isWorkingInstant(at('2026-12-28T16:59Z'), withExceptions)).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// Acceptance (b): the hand-walked weekend crossing
// -----------------------------------------------------------------------------------------------

describe('addWorkingHours — acceptance (b): an 8-hour task across a weekend (FR-SCH-07)', () => {
  it('finishes Monday 13:00 for a task starting Friday 13:00', () => {
    // Calendar: Mon-Fri, 09:00-17:00 UTC. Task: starts Fri 2026-11-27 13:00, duration 8h.
    //
    //   Fri 2026-11-27 13:00 -> 17:00   4h worked, 4h remaining   (the day closes at 17:00)
    //   Sat 2026-11-28                  not a working day, contributes 0
    //   Sun 2026-11-29                  not a working day, contributes 0
    //   Mon 2026-11-30 09:00 -> 13:00   4h worked, 0h remaining   <- finish
    //
    // Expected finish: 2026-11-30T13:00:00.000Z.
    expectInstant(addWorkingHours(at('2026-11-27T13:00Z'), 8, monFri)).toBe('2026-11-30T13:00Z');
  });

  it('finishes at close of business, not at the next morning, when the duration lands exactly', () => {
    // Fri 13:00 + 4h consumes exactly the rest of Friday. 17:00 Friday and 09:00 Monday are the
    // same point in working time; the earlier representative is the finish a Gantt chart must show
    // — a bar that ends on Monday morning after four hours of Friday work is simply wrong.
    expectInstant(addWorkingHours(at('2026-11-27T13:00Z'), 4, monFri)).toBe('2026-11-27T17:00Z');
  });

  it('reads the same clock in any host time zone (ADR-011)', () => {
    // The engine does no time-zone conversion, so a start given in UTC minutes is interpreted
    // against a UTC window: 2026-11-27T09:00Z is the start of the Friday window regardless of
    // where the process runs. See `timezone.test.ts` for the run-under-three-zones proof.
    //
    //   Fri 11-27 09:00-17:00   8h  (32h remaining)
    //   Sat / Sun               0h
    //   Mon 11-30 .. Thu 12-03  8h each, 32h  (0h remaining) -> finish Thu 2026-12-03T17:00Z
    expectInstant(addWorkingHours(at('2026-11-27T09:00Z'), 40, monFri)).toBe('2026-12-03T17:00Z');
  });
});

// -----------------------------------------------------------------------------------------------
// Acceptance (c): exceptions falling mid-task
// -----------------------------------------------------------------------------------------------

describe('addWorkingHours — acceptance (c): a full-day exception mid-task (FR-CAL-02)', () => {
  it('extends the task by exactly one working day', () => {
    // Calendar: Mon-Fri 09:00-17:00, one holiday on Wednesday 2026-12-02.
    // Task: starts Mon 2026-11-30 09:00, duration 24h (three working days).
    //
    // Without the holiday:
    //   Mon 11-30 09:00-17:00   8h   (16h remaining)
    //   Tue 12-01 09:00-17:00   8h   ( 8h remaining)
    //   Wed 12-02 09:00-17:00   8h   ( 0h remaining) -> finish Wed 2026-12-02T17:00Z
    //
    // With the holiday on Wed 12-02:
    //   Mon 11-30 09:00-17:00   8h   (16h remaining)
    //   Tue 12-01 09:00-17:00   8h   ( 8h remaining)
    //   Wed 12-02               holiday, contributes 0
    //   Thu 12-03 09:00-17:00   8h   ( 0h remaining) -> finish Thu 2026-12-03T17:00Z
    //
    // The finish moves by exactly one working day (17:00 Wed -> 17:00 Thu).
    const withHoliday = usable(
      makeCalendar({ id: calendarId(10), exceptions: [holiday('2026-12-02')] }),
    );

    expectInstant(addWorkingHours(at('2026-11-30T09:00Z'), 24, monFri)).toBe('2026-12-02T17:00Z');
    expectInstant(addWorkingHours(at('2026-11-30T09:00Z'), 24, withHoliday)).toBe(
      '2026-12-03T17:00Z',
    );
  });
});

describe('addWorkingHours — acceptance (c): a half-day exception mid-task (FR-CAL-02)', () => {
  it('extends the task by exactly the four hours the half-day removed', () => {
    // Calendar: Mon-Fri 09:00-17:00, with Wednesday 2026-12-02 cut to 09:00-13:00 (a 4h day).
    // Task: starts Mon 2026-11-30 09:00, duration 24h.
    //
    // Without the exception the finish is Wed 2026-12-02T17:00Z (walked out above).
    //
    // With the 09:00-13:00 half-day on Wed 12-02:
    //   Mon 11-30 09:00-17:00   8h   (16h remaining)
    //   Tue 12-01 09:00-17:00   8h   ( 8h remaining)
    //   Wed 12-02 09:00-13:00   4h   ( 4h remaining)   <- the half-day, 4h short of a full day
    //   Thu 12-03 09:00-13:00   4h   ( 0h remaining)   -> finish Thu 2026-12-03T13:00Z
    //
    // Wed 17:00 -> Thu 13:00 is 4 working hours later: exactly what the half-day took away.
    const withHalfDay = usable(
      makeCalendar({ id: calendarId(11), exceptions: [halfDay('2026-12-02', null, 13 * 60)] }),
    );

    expectInstant(addWorkingHours(at('2026-11-30T09:00Z'), 24, withHalfDay)).toBe(
      '2026-12-03T13:00Z',
    );
    expect(workingHoursBetween(at('2026-12-02T17:00Z'), at('2026-12-03T13:00Z'), withHalfDay)).toBe(
      4,
    );
  });

  it('starts a task inside a half-day at the overridden opening time, not the weekly one', () => {
    // 2026-12-28 opens at 12:00 in `MON_FRI_WITH_EXCEPTIONS`. A task released at 09:00 that day
    // cannot start before the calendar opens.
    expectInstant(addWorkingHours(at('2026-12-28T09:00Z'), 0, withExceptions)).toBe(
      '2026-12-28T12:00Z',
    );
    // ... and 5h of work then runs 12:00-17:00, finishing the same day.
    expectInstant(addWorkingHours(at('2026-12-28T09:00Z'), 5, withExceptions)).toBe(
      '2026-12-28T17:00Z',
    );
  });
});

// -----------------------------------------------------------------------------------------------
// Acceptance (d): milestones
// -----------------------------------------------------------------------------------------------

describe('addWorkingHours — acceptance (d): zero-duration milestones (FR-TSK-04)', () => {
  it('snaps a milestone on a non-working instant forward to the next working instant', () => {
    // 2026-11-28 is a Saturday. A milestone "at 02:00 Saturday" occurs, in reality, when work next
    // resumes: Monday 2026-11-30 at 09:00, the opening of the next working window.
    expectInstant(addWorkingHours(at('2026-11-28T02:00Z'), 0, monFri)).toBe('2026-11-30T09:00Z');
  });

  it('leaves a milestone already inside working time exactly where it is', () => {
    const inside = at('2026-11-27T13:37Z');
    expect(addWorkingHours(inside, 0, monFri)).toBe(inside);
    expect(nextWorkingInstant(inside, monFri)).toBe(inside);
  });

  it('snaps forward from the closing instant, which is not itself working', () => {
    // 17:00 Friday is the end of the window and therefore non-working; the next working instant is
    // Monday 09:00. This is the same half-open rule `isWorkingInstant` asserts.
    expectInstant(addWorkingHours(at('2026-11-27T17:00Z'), 0, monFri)).toBe('2026-11-30T09:00Z');
  });

  it('never moves a milestone backwards', () => {
    // A snap that reached for the *previous* working instant would let a milestone precede the
    // predecessor that released it — the one failure mode that turns a milestone into a lie.
    for (const iso of [
      '2026-11-27T08:00Z',
      '2026-11-27T09:00Z',
      '2026-11-27T17:00Z',
      '2026-11-28T02:00Z',
      '2026-11-29T23:59Z',
      '2026-12-25T04:00Z',
    ]) {
      const start = at(iso);
      expect(addWorkingHours(start, 0, withExceptions)).toBeGreaterThanOrEqual(start);
      expect(isWorkingInstant(addWorkingHours(start, 0, withExceptions), withExceptions)).toBe(
        true,
      );
    }
  });

  it('crosses a long non-working run to find the next working instant', () => {
    // `WEDNESDAYS_ONLY` works 10:00-14:00 on Wednesdays alone. From Thursday, the next working
    // instant is six days later. 2026-11-26 is a Thursday; 2026-12-02 is the following Wednesday.
    expectInstant(addWorkingHours(at('2026-11-26T15:00Z'), 0, wednesdays)).toBe(
      '2026-12-02T10:00Z',
    );
  });
});

// -----------------------------------------------------------------------------------------------
// Negative lag (FR-SCH-02)
// -----------------------------------------------------------------------------------------------

describe('addWorkingHours — negative lag walks backwards (FR-SCH-02)', () => {
  it('retreats across a weekend the same way it advances across one', () => {
    // Mon 2026-11-30 13:00 minus 8 working hours:
    //   Mon 11-30 13:00 <- 09:00   4h retreated, 4h remaining
    //   Sun / Sat                  contribute 0
    //   Fri 11-27 17:00 <- 13:00   4h retreated, 0h remaining  <- result
    expectInstant(addWorkingHours(at('2026-11-30T13:00Z'), -8, monFri)).toBe('2026-11-27T13:00Z');
  });

  it('is the exact inverse of the forward walk for the acceptance (b) case', () => {
    const start = at('2026-11-27T13:00Z');
    const finish = addWorkingHours(start, 8, monFri);
    expect(addWorkingHours(finish, -8, monFri)).toBe(start);
  });

  it('skips a holiday when retreating, extending the lead by a working day', () => {
    // `MON_FRI_WITH_EXCEPTIONS` holds holidays on Thu 2026-11-26 and Fri 2026-11-27, and a
    // *working* Saturday on 2026-11-28. Retreating 8h from Mon 2026-11-30 09:00:
    //   Mon 11-30 09:00   nothing behind it on this day
    //   Sun 11-29         not working
    //   Sat 11-28 17:00 <- 09:00   8h retreated  <- result, the working Saturday
    expectInstant(addWorkingHours(at('2026-11-30T09:00Z'), -8, withExceptions)).toBe(
      '2026-11-28T09:00Z',
    );
  });

  it('treats -0 hours as the forward snap, not as a backward one', () => {
    // `-0 < 0` is false in JS, so this takes the forward path — which is the behaviour a caller
    // wants (a milestone never moves back) and is asserted so a future refactor cannot flip it.
    expectInstant(addWorkingHours(at('2026-11-28T02:00Z'), -0, monFri)).toBe('2026-11-30T09:00Z');
  });
});

// -----------------------------------------------------------------------------------------------
// workingHoursBetween (FR-SCH-05 float input)
// -----------------------------------------------------------------------------------------------

describe('workingHoursBetween — the inverse measure (FR-SCH-07)', () => {
  it('counts only working time across a weekend', () => {
    // Fri 13:00 -> Mon 13:00 is 71 wall-clock hours and 8 working hours (4 on Friday, 4 on Monday).
    expect(workingHoursBetween(at('2026-11-27T13:00Z'), at('2026-11-30T13:00Z'), monFri)).toBe(8);
  });

  it('is zero across a gap, so both ends of a weekend are the same point in working time', () => {
    expect(workingHoursBetween(at('2026-11-27T17:00Z'), at('2026-11-30T09:00Z'), monFri)).toBe(0);
    expect(workingHoursBetween(at('2026-11-28T02:00Z'), at('2026-11-29T22:00Z'), monFri)).toBe(0);
  });

  it('is signed, because float is allowed to go negative under a hard constraint', () => {
    expect(workingHoursBetween(at('2026-11-30T13:00Z'), at('2026-11-27T13:00Z'), monFri)).toBe(-8);
  });

  it('counts a full working week as 40 hours and a year as the pattern implies', () => {
    expect(workingHoursBetween(at('2026-11-30T09:00Z'), at('2026-12-07T09:00Z'), monFri)).toBe(40);
    // 2026-01-01 is a Thursday; 2027-01-01 is a Friday. The span contains 52 weeks and 1 day, so
    // 52 * 5 working days plus the extra Thursday = 261 days = 2088 hours.
    expect(workingHoursBetween(at('2026-01-01T00:00Z'), at('2027-01-01T00:00Z'), monFri)).toBe(
      261 * 8,
    );
  });

  it('nets exception days out of the span', () => {
    // Same span as above on the exception calendar. Its exceptions inside 2026-01-01..2027-01-01:
    //   2026-11-26 holiday (Thu, working)    -8h
    //   2026-11-27 holiday (Fri, working)    -8h
    //   2026-11-28 working Saturday          +8h
    //   2026-12-24 half-day 09:00-13:00      -4h
    //   2026-12-25 holiday (Fri, working)    -8h
    //   2026-12-28 late start 12:00-17:00    -3h
    //   2027-01-01 falls on the boundary and is *not* before 2027-01-01T00:00Z, so it does not count
    // Net: -23h against the 2088h pattern total.
    expect(
      workingHoursBetween(at('2026-01-01T00:00Z'), at('2027-01-01T00:00Z'), withExceptions),
    ).toBe(261 * 8 - 23);
  });

  it('measures pre-epoch spans correctly, where truncating division would not', () => {
    // 1969-12-29 is a Monday. Mon 09:00 -> Fri 17:00 of the same week is 5 * 8 = 40 hours.
    expect(workingHoursBetween(at('1969-12-29T09:00Z'), at('1970-01-02T17:00Z'), monFri)).toBe(40);
  });
});

// -----------------------------------------------------------------------------------------------
// compileCalendar
// -----------------------------------------------------------------------------------------------

describe('compileCalendar — determinism and exception resolution', () => {
  it('does not depend on the order the exceptions arrived in', () => {
    const forwards = MON_FRI_WITH_EXCEPTIONS.exceptions;
    const backwards = [...forwards].reverse();

    const a = usable(MON_FRI_WITH_EXCEPTIONS);
    const b = usable(makeCalendar({ ...MON_FRI_WITH_EXCEPTIONS, exceptions: backwards }));

    expect(b).toEqual(a);
  });

  it('never mutates the calendar it was given', () => {
    const source = makeCalendar({ exceptions: [holiday('2026-12-25'), holiday('2026-11-26')] });
    const snapshot = structuredClone(source);
    usable(source);
    expect(source).toEqual(snapshot);
  });

  it('resolves a duplicated exception date first-wins after sorting, not by input order', () => {
    // The DB has UNIQUE (calendar_id, date), so this is a caller bug — but it must resolve to the
    // same calendar whichever order the rows arrive in, or the schedule depends on a query plan.
    const rows = [halfDay('2026-12-02', null, 13 * 60), holiday('2026-12-02')];
    const one = usable(makeCalendar({ id: calendarId(12), exceptions: rows }));
    const other = usable(makeCalendar({ id: calendarId(12), exceptions: [...rows].reverse() }));

    expect(one).toEqual(other);
    // `compareExceptions` sorts `isWorking: false` first, so the holiday wins in both orders.
    expect(workingWindowOnDay(one, utcDayNumber(at('2026-12-02T00:00Z')))).toBeNull();
  });

  it('treats an override that collapses the window as a non-working day', () => {
    // `calendar_exception` has no CHECK (end > start) on its override columns, so 09:00-09:00 is
    // reachable input. It means "no working time", not "a negative-length day".
    const collapsed = usable(
      makeCalendar({ id: calendarId(13), exceptions: [halfDay('2026-12-02', 9 * 60, 9 * 60)] }),
    );
    expect(isWorkingInstant(at('2026-12-02T10:00Z'), collapsed)).toBe(false);
    expect(workingHoursBetween(at('2026-12-01T09:00Z'), at('2026-12-03T17:00Z'), collapsed)).toBe(
      16,
    );
  });

  it('ignores a duplicate weekday in workingDays rather than double-counting the week', () => {
    const duplicated = usable(makeCalendar({ id: calendarId(14), workingDays: [1, 1, 2, 2, 3] }));
    // Mon+Tue+Wed at 8h each = 24h per week, not 40h.
    expect(workingHoursBetween(at('2026-11-30T00:00Z'), at('2026-12-07T00:00Z'), duplicated)).toBe(
      24,
    );
  });
});
