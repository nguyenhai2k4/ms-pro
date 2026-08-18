import { describe, expect, it } from 'vitest';
import type { CpmCalendarException } from '@projectapp/shared-types';
import { addWorkingHours, compileCalendar, workingHoursBetween } from './calendar.js';
import { MS_PER_DAY } from './instant.js';
import { calendarId, halfDay, holiday, makeCalendar } from './test-support/calendars.js';
import { createSeededRandom } from './test-support/random.js';

/**
 * Acceptance (h) — the perf spike, run in CI rather than spot-checked (CLAUDE.md invariant 5:
 * "perf budgets are tested, not assumed").
 *
 * **Budget: 5,000 `addWorkingHours` conversions against a calendar with 20 exceptions, under
 * 100ms.** This is the gate on the next work item (the forward/backward pass), because a pass over
 * 5,000 tasks calls this primitive at least twice per task and the phase budget for a full recalc
 * is 500ms.
 *
 * ## Timing lives here, not in `src/`
 *
 * `Date.now()` is a purity violation inside the engine (`eslint.config.mjs`, `purity.test.ts`), and
 * `cpm.ts` makes the same point about the result shape: "there is also no `elapsedMs` anywhere in
 * the result. Timing the engine requires reading a clock, so the perf harness times the call from
 * the outside." This file is that outside.
 *
 * ## Reading a failure here
 *
 * A machine-dependent threshold in CI is a flake risk, so the budget is deliberately generous
 * relative to the measured number (reported in the work item's hand-off) rather than tuned to it.
 * If this fails, the regression is structural — an accidental O(days) scan in a hot path, or an
 * allocation per day step — not a slow build agent. `warmup` runs first so the measurement is of
 * steady-state code rather than of the JIT's first pass.
 */

const CONVERSIONS = 5_000;
const BUDGET_MS = 100;

/** Twenty exceptions spread across a year: holidays, half-days and late starts (FR-CAL-02). */
function twentyExceptions(): CpmCalendarException[] {
  const exceptions: CpmCalendarException[] = [];
  for (let i = 0; i < 20; i += 1) {
    // Spread across 2026 at roughly 18-day intervals: 2026-01-05 plus 18i days, formatted by hand
    // so the fixture does not depend on the code under test to build its own input.
    const day = 20_458 + i * 18; // 2026-01-05 is day 20458
    const date = isoDateOf(day);
    if (i % 3 === 0) exceptions.push(holiday(date));
    else if (i % 3 === 1) exceptions.push(halfDay(date, null, 13 * 60));
    else exceptions.push(halfDay(date, 12 * 60, null));
  }
  return exceptions;
}

/** A tiny independent date formatter, so the perf fixture does not depend on `instant.ts`. */
function isoDateOf(dayNumber: number): string {
  const date = new Date(dayNumber * MS_PER_DAY);
  return date.toISOString().slice(0, 10);
}

const compiled = compileCalendar(
  makeCalendar({ id: calendarId(30), exceptions: twentyExceptions() }),
);
if (compiled.status !== 'usable') throw new Error('perf fixture calendar must compile');
const calendar = compiled.calendar;

/** 2026-01-01T00:00:00Z .. one year later, the span the conversions are drawn from. */
const WINDOW_START = 20_454 * MS_PER_DAY;
const WINDOW_MS = 365 * MS_PER_DAY;

function buildCases(seed: number, count: number): { start: number; hours: number }[] {
  const next = createSeededRandom(seed);
  const cases: { start: number; hours: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    cases.push({
      start: WINDOW_START + Math.floor(next() * WINDOW_MS),
      // A realistic spread of task durations: milestones, part-days, and multi-week efforts.
      hours: Math.floor(next() * 80),
    });
  }
  return cases;
}

describe('acceptance (h) — 5,000 duration conversions on a 20-exception calendar', () => {
  it(`completes ${CONVERSIONS} addWorkingHours calls in under ${BUDGET_MS}ms`, () => {
    const warmup = buildCases(0x1, 2_000);
    for (const { start, hours } of warmup) addWorkingHours(start, hours, calendar);

    const cases = buildCases(0x9e4f0, CONVERSIONS);

    const startedAt = Date.now();
    let checksum = 0;
    for (const { start, hours } of cases) {
      // Accumulated so the loop cannot be optimised away, and so a change that broke the result
      // would show up as a different checksum rather than as a suspiciously fast run.
      checksum += addWorkingHours(start, hours, calendar);
    }
    const elapsedMs = Date.now() - startedAt;

    expect(checksum).toBeGreaterThan(0);
    console.warn(
      `[perf] ${CONVERSIONS} addWorkingHours conversions (20 exceptions): ${elapsedMs}ms (budget ${BUDGET_MS}ms)`,
    );
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it(`completes ${CONVERSIONS} workingHoursBetween calls in under ${BUDGET_MS}ms`, () => {
    // The float calculation's primitive, measured on spans of up to a year — the case an O(days)
    // implementation would fail and the closed form does not notice.
    const cases = buildCases(0xf10a7, CONVERSIONS);
    const ends = buildCases(0xf10a8, CONVERSIONS);
    for (let i = 0; i < 1_000; i += 1) {
      workingHoursBetween(cases[i]?.start ?? 0, ends[i]?.start ?? 0, calendar);
    }

    const startedAt = Date.now();
    let checksum = 0;
    for (let i = 0; i < CONVERSIONS; i += 1) {
      checksum += workingHoursBetween(cases[i]?.start ?? 0, ends[i]?.start ?? 0, calendar);
    }
    const elapsedMs = Date.now() - startedAt;

    expect(Number.isFinite(checksum)).toBe(true);
    console.warn(
      `[perf] ${CONVERSIONS} workingHoursBetween calls (spans up to a year): ${elapsedMs}ms (budget ${BUDGET_MS}ms)`,
    );
    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it('compiles a 20-exception calendar 1,000 times well inside a generous budget', () => {
    // Compilation happens once per calendar per recompute — a handful of times, not once per task —
    // so 1,000 is already three orders of magnitude more than a 5,000-task pass needs. It is
    // measured rather than assumed because a pass that accidentally compiled *inside* its task loop
    // would be a 5,000x regression, and this is the number that would make that obvious.
    //
    // This assertion gets its own, wider budget rather than sharing BUDGET_MS: compilation measured
    // 29-72ms in isolation during development, which leaves too little headroom against BUDGET_MS's
    // 100ms once `pnpm -r test` runs six packages' suites concurrently and this file is competing
    // for CPU — exactly the "machine-dependent threshold" flake risk the file docstring warns
    // against, and this test tripped it. 10x the observed ceiling keeps the same structural
    // guarantee (no accidental O(n) hot-loop compilation) without being a CI coin flip.
    const COMPILES = 1_000;
    const COMPILE_BUDGET_MS = 500;
    const source = makeCalendar({ id: calendarId(31), exceptions: twentyExceptions() });

    const startedAt = Date.now();
    let usableCount = 0;
    for (let i = 0; i < COMPILES; i += 1) {
      if (compileCalendar(source).status === 'usable') usableCount += 1;
    }
    const elapsedMs = Date.now() - startedAt;

    expect(usableCount).toBe(COMPILES);
    console.warn(`[perf] ${COMPILES} compileCalendar calls (20 exceptions): ${elapsedMs}ms`);
    expect(elapsedMs).toBeLessThan(COMPILE_BUDGET_MS);
  });
});
