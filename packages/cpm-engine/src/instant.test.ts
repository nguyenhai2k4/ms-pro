import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  civilFromDays,
  daysFromCivil,
  floorDiv,
  floorMod,
  formatIsoDate,
  formatIsoDateTime,
  isoWeekdayOfDay,
  msWithinUtcDay,
  parseIsoDate,
  parseIsoDateTime,
  startOfUtcDay,
  utcDayNumber,
} from './instant.js';
import { createSeededRandom } from './test-support/random.js';

/**
 * UTC instant arithmetic (ADR-011).
 *
 * These tests are the foundation the calendar kernel's correctness rests on: if `isoWeekdayOfDay`
 * is off by one, every "Monday" in every schedule this product ever produces is wrong, and no
 * higher-level test would say so in a way anyone could read. So the weekday cases below name real
 * dates a reader can check against a wall calendar.
 *
 * `instant.ts` is also the module that makes `Date`'s absence survivable, so several of these
 * assertions are cross-checks against `Date`'s own UTC accessors — which are correct, just
 * unusable in engine source (they read a mutable global time zone in their non-`UTC` form, and
 * `eslint.config.mjs` bans the constructor outright rather than trying to police which accessor was
 * called). A test file may use it; the engine may not.
 */

describe('floorDiv / floorMod — correct for pre-epoch instants (ADR-011)', () => {
  it('rounds toward -infinity rather than toward zero', () => {
    // `Math.trunc(-1 / 7)` is 0, which would fold every day of the week before the epoch onto
    // day 0 and give six wrong weekdays. This is the whole reason the helper exists.
    expect(floorDiv(-1, 7)).toBe(-1);
    expect(floorDiv(-7, 7)).toBe(-1);
    expect(floorDiv(-8, 7)).toBe(-2);
    expect(floorDiv(13, 7)).toBe(1);
  });

  it('returns a non-negative remainder', () => {
    expect(floorMod(-1, 7)).toBe(6);
    expect(floorMod(-7, 7)).toBe(0);
    expect(floorMod(8, 7)).toBe(1);
  });
});

describe('civil date conversion', () => {
  it('places the epoch and a handful of hand-checkable dates', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(1970, 1, 2)).toBe(1);
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    expect(daysFromCivil(2000, 3, 1)).toBe(11017);
    expect(daysFromCivil(2026, 11, 27)).toBe(20784);
  });

  it('round-trips every day across a 400-year Gregorian cycle', () => {
    // 146097 days is one full leap cycle, so this covers every leap rule (4, 100, 400) many times.
    // Mismatches are collected rather than asserted per iteration: 160,000 `expect` calls cost
    // seconds of CI time to prove the same thing one assertion over a list proves.
    const mismatches: string[] = [];
    for (let day = -80_000; day <= 80_000; day += 1) {
      const civil = civilFromDays(day);
      const back = daysFromCivil(civil.year, civil.month, civil.day);
      if (back !== day) mismatches.push(`${day} -> ${JSON.stringify(civil)} -> ${back}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees with the platform on random dates, including pre-epoch ones', () => {
    const next = createSeededRandom(0x0ca1e2da);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const day = Math.floor(next() * 60_000) - 20_000;
      const civil = civilFromDays(day);
      const reference = new Date(day * MS_PER_DAY);
      if (
        civil.year !== reference.getUTCFullYear() ||
        civil.month !== reference.getUTCMonth() + 1 ||
        civil.day !== reference.getUTCDate()
      ) {
        mismatches.push(`day ${day}: ${JSON.stringify(civil)} vs ${reference.toISOString()}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('handles the leap day the century rule takes away and the 400 rule gives back', () => {
    expect(civilFromDays(daysFromCivil(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });
    expect(parseIsoDate('2100-02-29')).toBeNull(); // 2100 is not a leap year
    expect(parseIsoDate('2000-02-29')).not.toBeNull();
  });
});

describe('isoWeekdayOfDay — 1 = Monday, derived in UTC (ADR-011, FR-CAL-01)', () => {
  it('names the weekday of dates a reader can check on a wall calendar', () => {
    const weekdayOf = (date: string): number => {
      const day = parseIsoDate(date);
      expect(day).not.toBeNull();
      return isoWeekdayOfDay(day ?? 0);
    };

    expect(weekdayOf('1970-01-01')).toBe(4); // the epoch was a Thursday
    expect(weekdayOf('2026-11-23')).toBe(1); // Monday
    expect(weekdayOf('2026-11-27')).toBe(5); // Friday
    expect(weekdayOf('2026-11-28')).toBe(6); // Saturday
    expect(weekdayOf('2026-11-29')).toBe(7); // Sunday
    expect(weekdayOf('2026-11-30')).toBe(1); // Monday again
  });

  it('stays in 1..7 for pre-epoch days, where a truncating division would not', () => {
    for (let day = -400; day <= 400; day += 1) {
      const weekday = isoWeekdayOfDay(day);
      expect(weekday).toBeGreaterThanOrEqual(1);
      expect(weekday).toBeLessThanOrEqual(7);
      // ISO weekday and the platform's Sunday-based `getUTCDay` differ only in numbering.
      const utcDay = new Date(day * MS_PER_DAY).getUTCDay();
      expect(weekday % 7).toBe(utcDay);
    }
  });
});

describe('ISO-8601 conversion at the engine boundary (primitives.ts, ADR-011)', () => {
  it('parses the shape isoDateTimeSchema accepts', () => {
    expect(parseIsoDateTime('1970-01-01T00:00:00.000Z')).toBe(0);
    expect(parseIsoDateTime('1970-01-01T00:00:00Z')).toBe(0);
    expect(parseIsoDateTime('2026-11-27T13:00:00.000Z')).toBe(20784 * MS_PER_DAY + 13 * 3_600_000);
    expect(parseIsoDateTime('2026-11-27T13:00:00.5Z')).toBe(
      20784 * MS_PER_DAY + 13 * 3_600_000 + 500,
    );
  });

  it('refuses anything carrying a non-UTC offset, rather than converting it', () => {
    // ADR-011: "the engine performs no time-zone conversion of any kind". Silently normalising
    // +09:00 here would be doing exactly that, in the one place nobody would look for it.
    expect(parseIsoDateTime('2026-11-27T13:00:00+09:00')).toBeNull();
    expect(parseIsoDateTime('2026-11-27T13:00:00')).toBeNull();
    expect(parseIsoDateTime('2026-11-27')).toBeNull();
    expect(parseIsoDateTime('not a date')).toBeNull();
  });

  it('refuses impossible dates and times rather than rolling them over', () => {
    expect(parseIsoDateTime('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseIsoDateTime('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseIsoDateTime('2026-11-27T24:00:00Z')).toBeNull();
    expect(parseIsoDateTime('2026-12-31T23:59:60Z')).toBeNull(); // a leap second has no epoch ms
    expect(parseIsoDate('2026-11-31')).toBeNull();
  });

  it('formats byte-identically to the string the API and the database exchange', () => {
    const next = createSeededRandom(0x15015015);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      // A span of roughly +/- 27 years around the epoch, at millisecond resolution.
      const instant = Math.floor(next() * 1_700_000_000_000) - 100_000_000_000;
      const ours = formatIsoDateTime(instant);
      const platform = new Date(instant).toISOString();
      if (ours !== platform) mismatches.push(`${instant}: ${ours} vs ${platform}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('round-trips parse -> format -> parse', () => {
    const next = createSeededRandom(0x7e577e57);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const instant = Math.floor(next() * 4_000_000_000_000) - 1_000_000_000_000;
      const iso = formatIsoDateTime(instant);
      if (parseIsoDateTime(iso) !== instant) mismatches.push(`${instant} -> ${iso}`);
    }
    expect(mismatches).toEqual([]);
  });

  it('formats the date-only form an exception is keyed by', () => {
    expect(formatIsoDate(parseIsoDateTime('2026-11-27T23:59:59.999Z') ?? 0)).toBe('2026-11-27');
    expect(formatIsoDate(parseIsoDateTime('2026-11-28T00:00:00.000Z') ?? 0)).toBe('2026-11-28');
  });
});

describe('day/instant decomposition', () => {
  it('splits an instant into a day number and a millisecond offset that add back up', () => {
    const next = createSeededRandom(0xdec0de);
    const mismatches: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const instant = Math.floor(next() * 4_000_000_000_000) - 1_000_000_000_000;
      const day = utcDayNumber(instant);
      const msOfDay = msWithinUtcDay(instant);
      if (msOfDay < 0 || msOfDay >= MS_PER_DAY || startOfUtcDay(day) + msOfDay !== instant) {
        mismatches.push(`${instant} -> day ${day} + ${msOfDay}ms`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
