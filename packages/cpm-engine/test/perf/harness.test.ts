import { describe, expect, it } from 'vitest';
import {
  budgetVerdict,
  DEFAULT_WARMUP_RUNS,
  formatSample,
  measure,
  MINIMUM_RUNS,
  percentile,
  PERF_BUDGETS,
} from './harness.js';

/**
 * The harness's own tests. A measurement tool nobody has tested is a source of numbers, not
 * evidence — and the specific ways this one could be quietly wrong (a p95 that is really a mean, a
 * budget constant copied instead of imported, warm-up runs leaking into the sample) all produce
 * plausible-looking output rather than a failure.
 */

describe('percentile', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses nearest-rank, so every reported figure is a run that actually happened', () => {
    expect(percentile(ten, 0)).toBe(1);
    expect(percentile(ten, 50)).toBe(5);
    expect(percentile(ten, 95)).toBe(10);
    expect(percentile(ten, 100)).toBe(10);
  });

  it('picks the 19th of 20 for p95 — the value FR-SCH-06 is written against', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 95)).toBe(19);
  });

  it('is not secretly a mean', () => {
    // One catastrophic outlier moves p95 and max; it must not move p50.
    const skewed = [...Array.from({ length: 19 }, () => 1), 1000];
    expect(percentile(skewed, 50)).toBe(1);
    expect(percentile(skewed, 95)).toBe(1);
    expect(percentile(skewed, 100)).toBe(1000);
  });

  it('refuses an empty sample rather than returning NaN', () => {
    expect(() => percentile([], 95)).toThrow(RangeError);
  });
});

describe('measure', () => {
  it('runs exactly the requested number of measured runs, plus warm-ups', () => {
    let calls = 0;
    const sample = measure(
      () => {
        calls += 1;
        return calls;
      },
      { label: 'counter', runs: 25, warmupRuns: 3 },
    );

    expect(calls).toBe(28);
    expect(sample.runs).toBe(25);
    expect(sample.warmupRuns).toBe(3);
    expect(sample.sortedMs).toHaveLength(25);
  });

  it('discards warm-up runs from the sample', () => {
    // The first call sleeps; the rest do not. If warm-ups leaked in, max would carry the sleep.
    let call = 0;
    const sample = measure(
      () => {
        call += 1;
        if (call === 1) spin(30);
        return call;
      },
      { label: 'warmup', warmupRuns: 1 },
    );

    expect(sample.maxMs).toBeLessThan(20);
  });

  it('defaults to a sample large enough for p95 to mean something', () => {
    const sample = measure(() => 1, { label: 'defaults' });
    expect(sample.runs).toBe(MINIMUM_RUNS);
    expect(sample.warmupRuns).toBe(DEFAULT_WARMUP_RUNS);
  });

  it('refuses too small a sample rather than reporting a meaningless p95', () => {
    expect(() => measure(() => 1, { label: 'tiny', runs: 5 })).toThrow(RangeError);
    expect(() => measure(() => 1, { label: 'fractional', runs: 20.5 })).toThrow(RangeError);
    expect(() => measure(() => 1, { label: 'negative warmup', warmupRuns: -1 })).toThrow(
      RangeError,
    );
  });

  it('measures real elapsed time, ordered as min <= p50 <= p95 <= max', () => {
    const sample = measure(() => spin(2), { label: 'spin 2ms', runs: 20, warmupRuns: 2 });

    expect(sample.minMs).toBeGreaterThan(0);
    expect(sample.minMs).toBeLessThanOrEqual(sample.p50Ms);
    expect(sample.p50Ms).toBeLessThanOrEqual(sample.p95Ms);
    expect(sample.p95Ms).toBeLessThanOrEqual(sample.maxMs);
    // Loose bound on purpose: this asserts the clock is connected, not that the machine is fast.
    expect(sample.p50Ms).toBeGreaterThanOrEqual(1);
  });
});

describe('budgetVerdict', () => {
  const sample = measure(() => 1, { label: 'noop' });

  it('passes at or under budget and fails over it', () => {
    expect(budgetVerdict({ ...sample, p95Ms: 400 }, 500).pass).toBe(true);
    expect(budgetVerdict({ ...sample, p95Ms: 500 }, 500).pass).toBe(true);
    expect(budgetVerdict({ ...sample, p95Ms: 501 }, 500).pass).toBe(false);
  });

  it('reports headroom as a percentage, negative when over', () => {
    expect(budgetVerdict({ ...sample, p95Ms: 250 }, 500).headroomPct).toBe(50);
    expect(budgetVerdict({ ...sample, p95Ms: 750 }, 500).headroomPct).toBe(-50);
  });

  it('reads its thresholds from PERF_BUDGETS rather than a literal', () => {
    // The regression this guards is silent: a hard-coded 500 keeps passing on the day the budget is
    // tightened to 300, and the test whose job is to notice a regression is the last to notice it.
    expect(PERF_BUDGETS.fullRecalcMs).toBe(500);
    expect(PERF_BUDGETS.fullRecalcTaskCount).toBe(5000);
    expect(PERF_BUDGETS.incrementalRecalcMs).toBe(150);
    expect(Object.isFrozen(PERF_BUDGETS)).toBe(true);
  });
});

describe('formatSample', () => {
  const sample = measure(() => 1, { label: 'noop' });

  it('is readable in a failed CI log', () => {
    expect(
      formatSample({ ...sample, p95Ms: 123.456, p50Ms: 100, minMs: 90, maxMs: 200 }),
    ).toContain('noop: p95 123.46ms');
  });

  it('says plainly whether the number is over budget', () => {
    expect(formatSample({ ...sample, p95Ms: 600 }, 500)).toContain('OVER budget 500ms');
    expect(formatSample({ ...sample, p95Ms: 400 }, 500)).toContain('within budget 500ms');
  });
});

/** Busy-waits for roughly `ms`. Sleeping is not an option — the point is to occupy the clock. */
function spin(ms: number): number {
  const startedAt = performance.now();
  let ticks = 0;
  while (performance.now() - startedAt < ms) ticks += 1;
  return ticks;
}
