import { describe, expect, it } from 'vitest';
import type { WorkingTimeCalendar } from './calendar.js';
import {
  addWorkingHours,
  isWorkingInstant,
  workingHoursBetween,
  workingMillisecondsBetween,
  workingWindowOnDay,
} from './calendar.js';
import { MS_PER_DAY, MS_PER_HOUR, formatIsoDateTime, utcDayNumber } from './instant.js';
import {
  ALWAYS_WORKING,
  MON_FRI_9_TO_5,
  MON_FRI_WITH_EXCEPTIONS,
  MON_SAT_8_TO_4,
  WEDNESDAYS_ONLY,
  usable,
} from './test-support/calendars.js';
import { createSeededRandom } from './test-support/random.js';

/**
 * Property tests for the working-time kernel (acceptance (a) and (e)).
 *
 * The hand-verified cases in `calendar.test.ts` say what the answer is for the dates a human can
 * check. These say what must be true for *every* date, which is the only way to cover the cases
 * nobody thought to write down — a task that starts inside a half-day, a lead that lands exactly on
 * a holiday, a span that begins on the closing minute of a working Saturday.
 *
 * Randomness is seeded (`test-support/random.ts`): a failure here reproduces from the seed in the
 * test file alone, because a property test that fails one run in a thousand with an input nobody
 * can reconstruct is worse than no test.
 *
 * ## The scanning oracle
 *
 * `workingHoursBetween` is a closed form — a weekly-pattern formula plus a prefix sum over
 * exceptions — so it costs O(log exceptions) regardless of how far apart the two instants are.
 * That is what keeps the backward pass's float calculation inside the 500ms budget on a multi-year
 * project, and it is also exactly the kind of arithmetic that is wrong in one alignment case out of
 * a hundred. `scanWorkingMsBetween` below is the obvious, slow, obviously-correct version: it walks
 * one day at a time and adds up the windows. The property test asserts they agree on thousands of
 * random spans. This is the same shape of guard as "incremental recompute equals full recompute" —
 * a fast path is only safe when a stupid path is standing next to it.
 */

const CALENDARS: readonly { readonly name: string; readonly calendar: WorkingTimeCalendar }[] = [
  { name: '5-day week (Mon-Fri 09:00-17:00)', calendar: usable(MON_FRI_9_TO_5) },
  { name: '6-day week (Mon-Sat 08:00-16:00)', calendar: usable(MON_SAT_8_TO_4) },
  { name: '5-day week with 7 exceptions', calendar: usable(MON_FRI_WITH_EXCEPTIONS) },
  { name: 'round-the-clock', calendar: usable(ALWAYS_WORKING) },
  { name: 'one working day a week', calendar: usable(WEDNESDAYS_ONLY) },
];

/** 2026-01-01T00:00:00Z, the start of the window the random instants are drawn from. */
const WINDOW_START = 20_454 * MS_PER_DAY;
/** Roughly two years of milliseconds — wide enough to cross every exception in the fixtures. */
const WINDOW_MS = 730 * MS_PER_DAY;

function randomInstant(next: () => number): number {
  return WINDOW_START + Math.floor(next() * WINDOW_MS);
}

/** A readable failure message; an epoch number tells a reader nothing about which case broke. */
function describeInstant(instant: number): string {
  return formatIsoDateTime(instant);
}

/**
 * The slow oracle: working milliseconds between two instants, counted one UTC day at a time.
 * Deliberately shares nothing with `workingMillisecondsBefore` except `workingWindowOnDay`, which
 * is the day-lookup both agree on by definition.
 */
function scanWorkingMsBetween(start: number, end: number, calendar: WorkingTimeCalendar): number {
  if (end < start) return -scanWorkingMsBetween(end, start, calendar);

  let total = 0;
  const lastDay = utcDayNumber(end);
  for (let day = utcDayNumber(start); day <= lastDay; day += 1) {
    const window = workingWindowOnDay(calendar, day);
    if (window === null) continue;
    const dayStart = day * MS_PER_DAY;
    const from = Math.min(Math.max(start - dayStart, window.startMs), window.endMs);
    const to = Math.min(Math.max(end - dayStart, window.startMs), window.endMs);
    total += to - from;
  }
  return total;
}

// -----------------------------------------------------------------------------------------------
// Acceptance (a): the round-trip property
// -----------------------------------------------------------------------------------------------

describe.each(CALENDARS)(
  'acceptance (a) — workingHoursBetween(t, addWorkingHours(t, h)) === h on the $name',
  ({ calendar }) => {
    it('holds for 10,000 random (instant, positive whole hours) pairs', () => {
      const next = createSeededRandom(0xa11ca1e2);
      for (let i = 0; i < 10_000; i += 1) {
        const start = randomInstant(next);
        const hours = 1 + Math.floor(next() * 120); // 1h .. 120h — up to three working weeks
        const finish = addWorkingHours(start, hours, calendar);

        expect(
          workingHoursBetween(start, finish, calendar),
          `${describeInstant(start)} + ${hours}h landed on ${describeInstant(finish)}`,
        ).toBe(hours);
      }
    });

    it('never returns a finish before the start, and never lands in non-working time', () => {
      const next = createSeededRandom(0x0f1a5c0);
      for (let i = 0; i < 5_000; i += 1) {
        const start = randomInstant(next);
        const hours = Math.floor(next() * 80);
        const finish = addWorkingHours(start, hours, calendar);

        expect(finish).toBeGreaterThanOrEqual(start);
        // A finish is either inside a working window or exactly on a window's closing instant —
        // never adrift in the middle of a night. `isWorkingInstant(finish - 1)` covers the second
        // case: the last millisecond consumed was working time.
        const landedWell =
          hours === 0
            ? isWorkingInstant(finish, calendar)
            : isWorkingInstant(finish, calendar) || isWorkingInstant(finish - 1, calendar);
        expect(
          landedWell,
          `${describeInstant(start)} + ${hours}h -> ${describeInstant(finish)}`,
        ).toBe(true);
      }
    });

    it('is monotonic in the duration: more hours never finishes earlier', () => {
      const next = createSeededRandom(0x3c0ffee);
      for (let i = 0; i < 2_000; i += 1) {
        const start = randomInstant(next);
        const hours = Math.floor(next() * 60);
        const more = hours + 1 + Math.floor(next() * 10);
        expect(addWorkingHours(start, more, calendar)).toBeGreaterThanOrEqual(
          addWorkingHours(start, hours, calendar),
        );
      }
    });
  },
);

// -----------------------------------------------------------------------------------------------
// Acceptance (e): negative lag walks backwards symmetrically
// -----------------------------------------------------------------------------------------------

describe.each(CALENDARS)('acceptance (e) — leads mirror lags on the $name', ({ calendar }) => {
  it('measures the same h working hours behind t as it walked back', () => {
    // The unconditional half of the symmetry, and it holds for *every* t, including one in the
    // middle of a weekend: there is no working time between a non-working instant and the end of
    // the previous working window, so snapping backwards costs nothing in working time.
    const next = createSeededRandom(0xbacc1a5);
    for (let i = 0; i < 10_000; i += 1) {
      const t = randomInstant(next);
      const hours = 1 + Math.floor(next() * 120);
      const back = addWorkingHours(t, -hours, calendar);

      expect(back).toBeLessThanOrEqual(t);
      expect(
        workingHoursBetween(back, t, calendar),
        `${describeInstant(t)} - ${hours}h landed on ${describeInstant(back)}`,
      ).toBe(hours);
    }
  });

  it('returns exactly to t when t is strictly inside a working window', () => {
    // Exact wall-clock equality is only available where t has a single representative in working
    // time. A t sitting on a window's *opening* instant shares its coordinate with the previous
    // window's closing instant, and forward conversion is contractually the earlier of the two
    // (`addWorkingHours`'s docstring says why: a task ending at close of business must report
    // 17:00, not 09:00 the next morning). So this case picks interior points, and the case below
    // states what happens on the boundary instead of pretending it does not exist.
    const next = createSeededRandom(0x1a7e210);
    let checked = 0;
    for (let i = 0; i < 120_000 && checked < 10_000; i += 1) {
      const t = randomInstant(next);
      const window = workingWindowOnDay(calendar, utcDayNumber(t));
      if (window === null) continue;
      const msOfDay = t - utcDayNumber(t) * MS_PER_DAY;
      if (msOfDay <= window.startMs || msOfDay >= window.endMs) continue;

      checked += 1;
      const hours = 1 + Math.floor(next() * 120);
      expect(
        addWorkingHours(addWorkingHours(t, -hours, calendar), hours, calendar),
        `round trip through -${hours}h from ${describeInstant(t)}`,
      ).toBe(t);
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  it('returns a working-time-equivalent instant for every other t, including gaps', () => {
    const next = createSeededRandom(0xd0b1e5);
    for (let i = 0; i < 10_000; i += 1) {
      const t = randomInstant(next);
      const hours = 1 + Math.floor(next() * 120);
      const roundTripped = addWorkingHours(addWorkingHours(t, -hours, calendar), hours, calendar);

      expect(
        workingHoursBetween(roundTripped, t, calendar),
        `round trip through -${hours}h from ${describeInstant(t)} gave ${describeInstant(roundTripped)}`,
      ).toBe(0);
      expect(roundTripped).toBeLessThanOrEqual(t);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// The closed form agrees with the scanning oracle
// -----------------------------------------------------------------------------------------------

describe.each(CALENDARS)(
  'workingHoursBetween equals a day-by-day scan on the $name',
  ({ calendar }) => {
    it('agrees on 10,000 random spans, in both directions', () => {
      const next = createSeededRandom(0x0aac1e5);
      const mismatches: string[] = [];
      for (let i = 0; i < 10_000; i += 1) {
        const a = randomInstant(next);
        const b = randomInstant(next);
        const expected = scanWorkingMsBetween(a, b, calendar);

        const forwards = workingMillisecondsBetween(a, b, calendar);
        const backwards = workingMillisecondsBetween(b, a, calendar);
        if (forwards !== expected || backwards !== -expected) {
          mismatches.push(
            `${describeInstant(a)} .. ${describeInstant(b)}: closed form ${forwards}/${backwards}, scan ${expected}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('agrees across the epoch, where a truncating division would silently disagree', () => {
      const next = createSeededRandom(0x19700101);
      const mismatches: string[] = [];
      for (let i = 0; i < 2_000; i += 1) {
        // +/- 400 days around 1970-01-01T00:00:00Z.
        const a = Math.floor(next() * 800 * MS_PER_DAY) - 400 * MS_PER_DAY;
        const b = Math.floor(next() * 800 * MS_PER_DAY) - 400 * MS_PER_DAY;
        const expected = scanWorkingMsBetween(a, b, calendar);
        const actual = workingMillisecondsBetween(a, b, calendar);
        if (actual !== expected) {
          mismatches.push(
            `${describeInstant(a)} .. ${describeInstant(b)}: closed form ${actual}, scan ${expected}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('reports the hours form as exactly the millisecond form divided by an hour', () => {
      const next = createSeededRandom(0x40c2);
      for (let i = 0; i < 1_000; i += 1) {
        const a = randomInstant(next);
        const b = randomInstant(next);
        expect(workingHoursBetween(a, b, calendar)).toBe(
          workingMillisecondsBetween(a, b, calendar) / MS_PER_HOUR,
        );
      }
    });
  },
);

describe('working time is additive, so float arithmetic can be composed', () => {
  it('splits any span at any interior point, exactly, in milliseconds', () => {
    // Exact in *milliseconds*, which is why `workingMillisecondsBetween` exists alongside the hours
    // form: the hours form divides by 3,600,000 and three fractional-hour spans do not have to sum
    // associatively in binary floating point (`a + b` can differ from the total by one ulp). Any
    // engine arithmetic that will be compared for equality therefore composes in milliseconds and
    // converts once, at the end.
    const calendar = usable(MON_FRI_WITH_EXCEPTIONS);
    const next = createSeededRandom(0xadd1710);
    const mismatches: string[] = [];
    for (let i = 0; i < 5_000; i += 1) {
      const a = randomInstant(next);
      const b = randomInstant(next);
      const c = randomInstant(next);
      const whole = workingMillisecondsBetween(a, c, calendar);
      const split =
        workingMillisecondsBetween(a, b, calendar) + workingMillisecondsBetween(b, c, calendar);
      if (whole !== split) {
        mismatches.push(`${describeInstant(a)} .. ${describeInstant(b)} .. ${describeInstant(c)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('is additive in hours to within floating-point noise', () => {
    const calendar = usable(MON_FRI_WITH_EXCEPTIONS);
    const next = createSeededRandom(0xadd1711);
    for (let i = 0; i < 2_000; i += 1) {
      const a = randomInstant(next);
      const b = randomInstant(next);
      const c = randomInstant(next);
      expect(workingHoursBetween(a, c, calendar)).toBeCloseTo(
        workingHoursBetween(a, b, calendar) + workingHoursBetween(b, c, calendar),
        9,
      );
    }
  });
});
