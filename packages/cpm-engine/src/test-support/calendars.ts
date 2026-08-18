import type { CalendarId, CpmCalendar, CpmCalendarException } from '@projectapp/shared-types';
import type { WorkingTimeCalendar } from '../calendar.js';
import { compileCalendar } from '../calendar.js';

/**
 * Calendar fixtures for the working-time kernel's tests.
 *
 * Every one of these is written the way a reader can hand-verify it: `MON_FRI_9_TO_5` is the
 * calendar the acceptance checks walk day by day in their comments, and the helpers below exist so
 * a test can say `at('2026-11-27T13:00Z')` instead of an epoch number nobody can check by eye.
 *
 * `usable()` unwraps `compileCalendar`'s status union for the (many) tests whose subject is not the
 * unusable case. It fails loudly rather than returning a fallback, because a fixture that silently
 * degraded to some other calendar would make every assertion downstream meaningless.
 */

export function calendarId(n: number): CalendarId {
  return `00000003-0000-4000-8000-${n.toString(16).padStart(12, '0')}` as CalendarId;
}

export function makeCalendar(overrides: Partial<CpmCalendar> = {}): CpmCalendar {
  return {
    id: calendarId(1),
    workingDays: [1, 2, 3, 4, 5],
    workingHoursStartMinute: 9 * 60,
    workingHoursEndMinute: 17 * 60,
    exceptions: [],
    ...overrides,
  };
}

/** A full-day holiday on `date` (FR-CAL-02). */
export function holiday(date: string): CpmCalendarException {
  return { date, isWorking: false, startMinuteOverride: null, endMinuteOverride: null };
}

/** A working date with an explicit window, in minutes from midnight UTC (FR-CAL-02 half-day). */
export function halfDay(
  date: string,
  startMinute: number | null,
  endMinute: number | null,
): CpmCalendarException {
  return {
    date,
    isWorking: true,
    startMinuteOverride: startMinute,
    endMinuteOverride: endMinute,
  };
}

/** Mon-Fri, 09:00-17:00 UTC. The calendar the hand-verified acceptance checks are written against. */
export const MON_FRI_9_TO_5 = makeCalendar();

/** Mon-Sat, 08:00-16:00 UTC — a second pattern for the round-trip property. */
export const MON_SAT_8_TO_4 = makeCalendar({
  id: calendarId(2),
  workingDays: [1, 2, 3, 4, 5, 6],
  workingHoursStartMinute: 8 * 60,
  workingHoursEndMinute: 16 * 60,
});

/** Mon-Fri 09:00-17:00 with a mix of holidays and half-days across late 2026 (FR-CAL-02). */
export const MON_FRI_WITH_EXCEPTIONS = makeCalendar({
  id: calendarId(3),
  exceptions: [
    holiday('2026-11-26'), // Thursday holiday
    holiday('2026-11-27'), // Friday holiday
    halfDay('2026-12-24', null, 13 * 60), // Christmas Eve: 09:00-13:00
    halfDay('2026-12-28', 12 * 60, null), // late start: 12:00-17:00
    holiday('2026-12-25'),
    holiday('2027-01-01'),
    halfDay('2026-11-28', null, null), // a *working* Saturday on the default window
  ],
});

/** Round-the-clock: every day, 00:00-24:00. Adjacent days' windows touch, with no gap between them. */
export const ALWAYS_WORKING = makeCalendar({
  id: calendarId(4),
  workingDays: [1, 2, 3, 4, 5, 6, 7],
  workingHoursStartMinute: 0,
  workingHoursEndMinute: 1440,
});

/** A single working day per week — the sparsest calendar that is still usable. */
export const WEDNESDAYS_ONLY = makeCalendar({
  id: calendarId(5),
  workingDays: [3],
  workingHoursStartMinute: 10 * 60,
  workingHoursEndMinute: 14 * 60,
});

export function usable(source: CpmCalendar): WorkingTimeCalendar {
  const compiled = compileCalendar(source);
  if (compiled.status !== 'usable') {
    throw new Error(`fixture calendar ${source.id} did not compile: ${compiled.diagnostic.code}`);
  }
  return compiled.calendar;
}
