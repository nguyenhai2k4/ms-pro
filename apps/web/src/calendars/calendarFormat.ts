import { ApiRequestError } from '../api/client.js';

/**
 * Pure formatting/parsing helpers for the calendar settings surface (FR-CAL-01..02).
 *
 * Kept free of React and of the API client's request machinery (aside from recognising
 * `ApiRequestError`) so they are trivial to exercise directly if that is ever useful, and so the
 * component files stay focused on markup and wiring.
 */

/** ISO weekday numbers, 1 = Monday .. 7 = Sunday, matching `weekdaySchema`. */
export const WEEKDAY_OPTIONS: ReadonlyArray<{ readonly value: number; readonly label: string }> = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

const WEEKDAY_LABEL_BY_NUMBER = new Map(
  WEEKDAY_OPTIONS.map((option) => [option.value, option.label]),
);

/** `[1, 3, 5]` -> `"Monday, Wednesday, Friday"` — never the raw ISO weekday numbers. */
export function formatWorkingDays(days: readonly number[]): string {
  if (days.length === 0) return 'No working days set';
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAY_LABEL_BY_NUMBER.get(day) ?? `Day ${day}`)
    .join(', ');
}

const pad = (value: number): string => String(value).padStart(2, '0');

/**
 * Minutes-from-midnight (0-1440, matching the wire schema) as `HH:MM` for display. `1440` is a
 * legitimate "runs to midnight" value the server accepts, so it renders as `24:00` rather than
 * wrapping to `00:00`.
 */
export function formatMinutesOfDay(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad(hours)}:${pad(minutes)}`;
}

export function formatHoursRange(startMinute: number, endMinute: number): string {
  return `${formatMinutesOfDay(startMinute)}–${formatMinutesOfDay(endMinute)}`;
}

/**
 * Same encoding, clamped to `23:59` for use as an `<input type="time">` value/default — that
 * control cannot represent `24:00`. The clamp only affects editing a calendar whose end-of-day
 * boundary is exactly midnight; the display path (`formatMinutesOfDay`) is unaffected.
 */
export function minutesToTimeInputValue(totalMinutes: number): string {
  const clamped = Math.min(1439, Math.max(0, totalMinutes));
  return formatMinutesOfDay(clamped);
}

/** Inverse of `minutesToTimeInputValue` for a `type="time"` field's `"HH:MM"` value. */
export function timeInputValueToMinutes(value: string): number {
  const [hoursPart, minutesPart] = value.split(':');
  const hours = Number(hoursPart ?? 0);
  const minutes = Number(minutesPart ?? 0);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return 0;
  return hours * 60 + minutes;
}

/**
 * Turns a thrown mutation error into UI copy. A 409 on the exceptions endpoint is specifically a
 * duplicate date on that calendar (the only unique constraint the route has) — name it, rather
 * than showing the server's generic conflict message or a raw error dump.
 */
export function describeApiError(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 409) return 'An exception already exists for that date.';
    return error.error.message.length > 0 ? error.error.message : fallback;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return fallback;
}
