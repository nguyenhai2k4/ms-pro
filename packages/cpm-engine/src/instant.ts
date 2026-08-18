import type { IsoDate, IsoDateTime } from '@projectapp/shared-types';

/**
 * UTC instant arithmetic (ADR-011, FR-SCH-07).
 *
 * Everything below is integer arithmetic on **milliseconds since the Unix epoch**. There is no
 * `Date` anywhere in this file, and that is not stylistic:
 *
 *  - `new Date('2026-11-27')` and `date.getDay()` read the *host's* time zone. A schedule computed
 *    on a laptop in `America/Los_Angeles` would then differ from the same input computed on a
 *    UTC container — which is invariant 1 ("same input -> byte-identical output") broken by ambient
 *    state, and it is precisely the bug ADR-011 was written to make impossible. `eslint.config.mjs`
 *    and `purity.test.ts` both ban `Date` in this package for this reason; this module is what
 *    makes that ban survivable.
 *  - `Date` is also mutable and allocates. The calendar kernel calls into here on its hot loop, and
 *    5,000 conversions must fit in 100ms.
 *
 * ## The instant representation
 *
 * `CpmScheduleInput` carries instants as ISO-8601 `Z`-suffixed strings (`primitives.ts` explains
 * why: `Date` does not survive JSON and carries an implicit local reading). Strings are the right
 * *transport* and the wrong *arithmetic* type — comparing predecessor finishes, taking maxima and
 * walking a calendar all want a number. So the boundary converts once, in `parseIsoDateTime` /
 * `formatIsoDateTime`, and every pass inside the engine works in `UtcInstant`.
 *
 * ## Civil date conversion
 *
 * `daysFromCivil` / `civilFromDays` are Howard Hinnant's shift-the-epoch-to-March algorithms,
 * exact for the whole range of dates a project can express and branch-free apart from the leap
 * adjustment. They are the only thing standing between "which UTC date is this instant on" and a
 * time-zone database.
 */

/**
 * An instant, as **milliseconds since 1970-01-01T00:00:00Z**. Always UTC — there is no other
 * reading of it anywhere in this package (ADR-011).
 *
 * Deliberately a bare `number` rather than a branded type: it is arithmetic, and every `+`, `-` and
 * `<` on it would otherwise need a cast, which is how a brand stops being read and starts being
 * pasted over.
 */
export type UtcInstant = number;

/** Days since 1970-01-01, UTC. Negative for dates before the epoch. */
export type UtcDayNumber = number;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;
export const MINUTES_PER_DAY = 1440;

/** 1970-01-01 was a Thursday, ISO weekday 4. Everything about weekday derivation follows from this. */
const EPOCH_ISO_WEEKDAY = 4;

/** Integer division rounding toward -infinity. `Math.trunc` would fold pre-epoch dates onto day 0. */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Non-negative remainder, matching `floorDiv`. `%` alone returns -1 for `-1 % 7`. */
export function floorMod(a: number, b: number): number {
  return a - floorDiv(a, b) * b;
}

/** The UTC date an instant falls on, as a day number. */
export function utcDayNumber(instant: UtcInstant): UtcDayNumber {
  return floorDiv(instant, MS_PER_DAY);
}

/** Milliseconds elapsed since midnight UTC of the instant's own date. Always `0 <= x < MS_PER_DAY`. */
export function msWithinUtcDay(instant: UtcInstant): number {
  return instant - utcDayNumber(instant) * MS_PER_DAY;
}

/** Midnight UTC at the start of a day number. */
export function startOfUtcDay(day: UtcDayNumber): UtcInstant {
  return day * MS_PER_DAY;
}

/**
 * ISO weekday of a day number: 1 = Monday .. 7 = Sunday, matching `weekdaySchema` and
 * `calendar.working_days` (ADR-011: derived in UTC, never from a local-time `getDay()`).
 */
export function isoWeekdayOfDay(day: UtcDayNumber): number {
  return floorMod(day + EPOCH_ISO_WEEKDAY - 1, 7) + 1;
}

export interface CivilDate {
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1-31. */
  readonly day: number;
}

/**
 * Days since 1970-01-01 for a proleptic-Gregorian civil date (Hinnant's `days_from_civil`).
 *
 * The trick is shifting the year to start in March so the leap day lands at the *end* of the year
 * and the month-length pattern becomes the affine `(153*m + 2) / 5`. Assumes a well-formed date;
 * callers that take dates from strings validate first (`parseIsoDate`).
 */
export function daysFromCivil(year: number, month: number, day: number): UtcDayNumber {
  const y = year - (month <= 2 ? 1 : 0);
  const era = floorDiv(y, 400);
  const yearOfEra = y - era * 400; // 0..399
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // 0..365
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** The inverse of `daysFromCivil` (Hinnant's `civil_from_days`). */
export function civilFromDays(day: UtcDayNumber): CivilDate {
  const z = day + 719468;
  const era = floorDiv(z, 146097);
  const dayOfEra = z - era * 146097; // 0..146096
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  ); // 0..399
  const year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100)); // 0..365
  const mp = Math.floor((5 * dayOfYear + 2) / 153); // 0..11, March-based
  const dayOfMonth = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1; // 1..31
  const month = mp + (mp < 10 ? 3 : -9); // 1..12
  return { year: year + (month <= 2 ? 1 : 0), month, day: dayOfMonth };
}

/** Days in a proleptic-Gregorian month. Used only to reject malformed input, never in a hot loop. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

const ISO_DATE_PATTERN = /^(-?\d{4,6})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME_PATTERN =
  /^(-?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * `YYYY-MM-DD` (the shape `isoDateSchema` enforces, and the shape Postgres serialises a `date`
 * column to) -> day number. Returns `null` for anything malformed, including a real-looking but
 * impossible date such as `2026-02-30`.
 *
 * Null rather than a throw, and null rather than a silent clamp: this parses *caller* data, and
 * `invariant.ts` reserves throwing for engine bugs. The one caller (`compileCalendar`) decides what
 * an unparseable exception date means.
 */
export function parseIsoDate(value: IsoDate | string): UtcDayNumber | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return daysFromCivil(year, month, day);
}

/**
 * ISO-8601 UTC instant (`isoDateTimeSchema`: `Z`-suffixed, optional fractional seconds) -> epoch
 * milliseconds. Returns `null` for anything malformed or carrying a non-`Z` offset — an offset the
 * engine silently normalised would be a time-zone conversion, which ADR-011 says it performs none
 * of.
 *
 * Sub-millisecond precision is truncated, not rounded: the engine's whole timeline is integer
 * milliseconds, and rounding a nanosecond up would let `parse(format(x)) !== x`.
 */
export function parseIsoDateTime(value: IsoDateTime | string): UtcInstant | null {
  const match = ISO_DATE_TIME_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  // 23:59:60 is a leap second. Rejected rather than absorbed: the engine's timeline is a uniform
  // count of milliseconds, and there is no minute in it that is 61 seconds long.
  if (hour > 23 || minute > 59 || second > 59) return null;
  const fraction = match[7] ?? '';
  const millisecond = Number(`${fraction}000`.slice(0, 3));
  return (
    startOfUtcDay(daysFromCivil(year, month, day)) +
    hour * 3_600_000 +
    minute * 60_000 +
    second * 1000 +
    millisecond
  );
}

function pad(value: number, width: number): string {
  const digits = String(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  return sign + (digits.length >= width ? digits : '0'.repeat(width - digits.length) + digits);
}

/**
 * Epoch milliseconds -> `YYYY-MM-DDTHH:mm:ss.sssZ`, the exact shape `isoDateTimeSchema` accepts and
 * the exact shape `Date.prototype.toISOString` produces — so a value round-trips through the API,
 * the database and a JSON payload unchanged. Milliseconds are always written, so two instants that
 * are equal always format identically (byte-identical output, invariant 1).
 */
export function formatIsoDateTime(instant: UtcInstant): IsoDateTime {
  const day = utcDayNumber(instant);
  const msOfDay = instant - day * MS_PER_DAY;
  const { year, month, day: dayOfMonth } = civilFromDays(day);
  const hour = Math.floor(msOfDay / 3_600_000);
  const minute = Math.floor(msOfDay / 60_000) % 60;
  const second = Math.floor(msOfDay / 1000) % 60;
  const millisecond = msOfDay % 1000;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(dayOfMonth, 2)}T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(millisecond, 3)}Z` as IsoDateTime;
}

/** Epoch milliseconds -> `YYYY-MM-DD` for the instant's UTC date. The key an exception is looked up by. */
export function formatIsoDate(instant: UtcInstant): IsoDate {
  const { year, month, day } = civilFromDays(utcDayNumber(instant));
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` as IsoDate;
}
