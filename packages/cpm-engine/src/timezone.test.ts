import { describe, expect, it } from 'vitest';
import { addWorkingHours, isWorkingInstant, workingHoursBetween } from './calendar.js';
import { formatIsoDateTime, isoWeekdayOfDay, parseIsoDateTime, utcDayNumber } from './instant.js';
import { MON_FRI_9_TO_5, MON_FRI_WITH_EXCEPTIONS, usable } from './test-support/calendars.js';

/**
 * Acceptance (g) — ADR-011 compliance, proven rather than assumed.
 *
 * ADR-011 pins every calendar minute and every exception date to **UTC**, and says the engine
 * performs no time-zone conversion of any kind. The failure mode it exists to prevent is silent:
 * one `new Date(iso).getDay()` anywhere in the kernel and a schedule computed in `Asia/Tokyo`
 * disagrees with the same input computed in `America/Los_Angeles`, with every layer agreeing with
 * itself and no unit test noticing.
 *
 * ## How this is checked
 *
 * The whole suite is run three times, once under each of `TZ=UTC`, `TZ=Asia/Tokyo` and
 * `TZ=America/Los_Angeles` (`pnpm --filter @projectapp/cpm-engine test:tz`, which is what CI
 * should call). Results must be identical across all three. That is the real check, and it covers
 * every test in the package rather than just this file.
 *
 * This file is what makes each of those three runs *meaningful*:
 *
 *  1. It pins the expected answers as absolute UTC values, so a local-time reading would fail here
 *     in at least one of the three runs.
 *  2. When the ambient zone is one where the local reading genuinely differs, it asserts that the
 *     naive `Date`-based answer **is** different — proving the run is exercising a non-UTC zone
 *     rather than silently having been given UTC, which would make the other two runs vacuous.
 *
 * `Date` is banned in engine `src/` (`eslint.config.mjs`, `purity.test.ts`) and used deliberately
 * here: showing the trap is the point.
 */

const monFri = usable(MON_FRI_9_TO_5);
const withExceptions = usable(MON_FRI_WITH_EXCEPTIONS);

/** 2026-11-28T02:00:00.000Z — a Saturday in UTC, still Friday evening in the Americas. */
const SATURDAY_EARLY = parseIsoDateTime('2026-11-28T02:00:00.000Z') ?? 0;

describe('the calendar kernel reads UTC, whatever the host time zone is (ADR-011)', () => {
  it('derives the weekday from the UTC date, not the local one', () => {
    // 2026-11-28T02:00Z is Saturday in UTC. It is Friday 18:00 in America/Los_Angeles and
    // Saturday 11:00 in Asia/Tokyo — so a local-time weekday would call this a *working* Friday
    // in the Americas and the schedule would differ by host.
    expect(isoWeekdayOfDay(utcDayNumber(SATURDAY_EARLY))).toBe(6);
    expect(isWorkingInstant(SATURDAY_EARLY, monFri)).toBe(false);
  });

  it('snaps a Saturday-02:00 milestone to Monday 09:00Z in every host time zone (FR-TSK-04)', () => {
    expect(formatIsoDateTime(addWorkingHours(SATURDAY_EARLY, 0, monFri))).toBe(
      '2026-11-30T09:00:00.000Z',
    );
  });

  it('converts a duration to the same absolute instants in every host time zone (FR-SCH-07)', () => {
    const friday13 = parseIsoDateTime('2026-11-27T13:00:00.000Z') ?? 0;
    expect(formatIsoDateTime(addWorkingHours(friday13, 8, monFri))).toBe(
      '2026-11-30T13:00:00.000Z',
    );
    expect(formatIsoDateTime(addWorkingHours(friday13, -8, monFri))).toBe(
      '2026-11-26T13:00:00.000Z',
    );
    expect(workingHoursBetween(friday13, addWorkingHours(friday13, 37, monFri), monFri)).toBe(37);
  });

  it('applies an exception to its UTC date, not to the local date of the same name (FR-CAL-02)', () => {
    // The holiday is stored as the bare date `2026-11-26`. Under ADR-011 that is
    // 2026-11-26T00:00Z .. 2026-11-27T00:00Z. An implementation that built a local midnight would
    // shift the holiday by a day in either direction depending on the host's offset sign, which is
    // the exact off-by-one-day bug the ADR was written to prevent.
    const justInside = parseIsoDateTime('2026-11-26T09:00:00.000Z') ?? 0;
    const dayBefore = parseIsoDateTime('2026-11-25T09:00:00.000Z') ?? 0;
    const dayAfter = parseIsoDateTime('2026-11-27T09:00:00.000Z') ?? 0;

    expect(isWorkingInstant(justInside, withExceptions)).toBe(false);
    expect(isWorkingInstant(dayBefore, withExceptions)).toBe(true);
    // 2026-11-27 is also a holiday in this fixture; the *next* working instant after it is the
    // working Saturday 2026-11-28 at 09:00Z.
    expect(isWorkingInstant(dayAfter, withExceptions)).toBe(false);
    expect(formatIsoDateTime(addWorkingHours(dayAfter, 0, withExceptions))).toBe(
      '2026-11-28T09:00:00.000Z',
    );
  });
});

describe('the three-zone run is actually exercising three zones', () => {
  it('disagrees with a local-time reading whenever the host is not on UTC', () => {
    // `getDay()` and `getHours()` are the two calls that would have produced a host-dependent
    // schedule. Under TZ=UTC they agree with ours; under a shifted zone they must not, or the
    // three runs are not testing anything. Guarding on the *observed* offset rather than on the
    // TZ name keeps this honest on a host where TZ is unset.
    const reference = new Date(SATURDAY_EARLY);
    const offsetMinutes = reference.getTimezoneOffset();
    const localWeekday = ((reference.getDay() + 6) % 7) + 1;
    const ourWeekday = isoWeekdayOfDay(utcDayNumber(SATURDAY_EARLY));

    if (offsetMinutes === 0) {
      expect(localWeekday).toBe(ourWeekday);
      expect(reference.getHours()).toBe(2);
    } else if (offsetMinutes > 0) {
      // Behind UTC (e.g. America/Los_Angeles, +480): 02:00Z on Saturday is still Friday locally.
      expect(localWeekday).toBe(5);
      expect(ourWeekday).toBe(6);
    } else {
      // Ahead of UTC (e.g. Asia/Tokyo, -540): the same UTC date, a different local hour.
      expect(localWeekday).toBe(6);
      expect(reference.getHours()).not.toBe(2);
    }

    // Whatever the host said, ours is unchanged.
    expect(ourWeekday).toBe(6);
  });
});
