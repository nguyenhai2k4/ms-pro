import { PERF_BUDGETS } from '@projectapp/shared-types';

/**
 * The performance measurement harness for FR-SCH-06 — P2 work item W2-3.
 *
 * ## Why this file is not under `src/`
 *
 * Timing anything requires reading a clock, and `packages/cpm-engine/src` may not read a clock:
 * `CLAUDE.md` invariant 1, the `packages/cpm-engine` block in `eslint.config.mjs`, and
 * `src/purity.test.ts`, which scans that directory independently in case someone loosens the lint
 * rule. `cpm.ts` states the consequence directly — "there is also no `elapsedMs` anywhere in the
 * result... the perf harness times the call from the outside". This *is* the outside. The engine
 * never learns it is being measured, and a measured build and a shipped build are the same build.
 *
 * ## What it measures, and what that is worth
 *
 * Wall-clock around a call, `performance.now()` to `performance.now()`, **p95 over at least 20
 * runs**. p95 rather than mean because FR-SCH-06 says p95, and because the mean of a distribution
 * with GC pauses in it is a number that describes no particular request. Warm-up runs are discarded
 * — the first few calls into a fresh JIT are measuring the JIT.
 *
 * Budgets come from `PERF_BUDGETS` in `packages/shared-types`, **imported, never copied**. A
 * hard-coded `500` here would keep passing on the day someone tightens the budget to 300, and the
 * test whose whole job is to notice a regression would be the last thing to notice it.
 *
 * ## Who calls this
 *
 * Three consumers, none of which should need to change it:
 *
 *  - **W2-3 (now):** `graph-build.perf.test.ts` times `buildGraph` + `topologicalOrder` over a 5,000
 *    task synthetic project. That is a **harness smoke-test, not an FR-SCH-06 measurement** —
 *    FR-SCH-06 budgets `computeSchedule`, which does not exist yet. The number it prints is
 *    reported as what it is.
 *  - **W3-1:** the same call with `computeSchedule` in place of the stand-in — the real
 *    `fullRecalcMs` measurement.
 *  - **W6-2:** the CI perf gate, which needs `budgetVerdict` to fail a build rather than print a
 *    warning, plus `formatSample` for a log line a human can read in a failed run.
 *
 * ## What it deliberately does not do
 *
 * It does not decide *whether* a regression fails the build; it returns a verdict and lets the
 * caller assert. A harness that threw would be unusable from a benchmark run that wants to record
 * a number over budget rather than abort on it.
 */

/** Discarded runs before measurement starts. Enough to get past a cold JIT, cheap enough to always do. */
export const DEFAULT_WARMUP_RUNS = 5;

/**
 * FR-SCH-06 says p95. With 20 runs, p95 is the 19th of 20 sorted samples — the highest value that is
 * not the single worst. Fewer runs than this and "p95" stops meaning anything; the harness refuses.
 */
export const MINIMUM_RUNS = 20;

export interface MeasureOptions {
  /** Appears in `formatSample` output and in assertion messages. */
  readonly label: string;
  /** Measured runs. Must be >= `MINIMUM_RUNS`. Defaults to `MINIMUM_RUNS`. */
  readonly runs?: number;
  /** Discarded runs before measurement. Defaults to `DEFAULT_WARMUP_RUNS`. */
  readonly warmupRuns?: number;
}

export interface PerfSample {
  readonly label: string;
  readonly runs: number;
  readonly warmupRuns: number;
  readonly minMs: number;
  readonly p50Ms: number;
  /** The number FR-SCH-06 is written against. */
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Every measured run, ascending. Kept so a caller can re-derive any other percentile. */
  readonly sortedMs: readonly number[];
}

export interface BudgetVerdict {
  readonly sample: PerfSample;
  readonly budgetMs: number;
  readonly pass: boolean;
  /** How much of the budget was left, as a percentage. Negative when over. */
  readonly headroomPct: number;
}

/**
 * Times `run` from the outside and returns its distribution.
 *
 * `run`'s return value is threaded into a sink so a JIT cannot decide the call is dead code and
 * delete the thing being measured. That is not paranoia: a pure function whose result is discarded
 * is exactly what an optimiser is entitled to remove, and the engine under measurement here is pure
 * by contract.
 */
export function measure<T>(run: () => T, options: MeasureOptions): PerfSample {
  const runs = options.runs ?? MINIMUM_RUNS;
  const warmupRuns = options.warmupRuns ?? DEFAULT_WARMUP_RUNS;

  if (!Number.isInteger(runs) || runs < MINIMUM_RUNS) {
    throw new RangeError(
      `perf harness: runs must be an integer >= ${MINIMUM_RUNS} for a meaningful p95, got ${runs}`,
    );
  }
  if (!Number.isInteger(warmupRuns) || warmupRuns < 0) {
    throw new RangeError(`perf harness: warmupRuns must be a non-negative integer`);
  }

  for (let i = 0; i < warmupRuns; i += 1) sink(run());

  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const startedAt = performance.now();
    const result = run();
    const finishedAt = performance.now();
    sink(result);
    samples.push(finishedAt - startedAt);
  }

  const sortedMs = [...samples].sort((a, b) => a - b);
  return {
    label: options.label,
    runs,
    warmupRuns,
    minMs: percentile(sortedMs, 0),
    p50Ms: percentile(sortedMs, 50),
    p95Ms: percentile(sortedMs, 95),
    maxMs: percentile(sortedMs, 100),
    sortedMs,
  };
}

/**
 * Nearest-rank percentile: the smallest sample at or above the given rank. No interpolation, so
 * every reported figure is a run that actually happened rather than an average of two that did.
 */
export function percentile(sortedMs: readonly number[], p: number): number {
  const first = sortedMs[0];
  if (first === undefined) {
    throw new RangeError('perf harness: cannot take a percentile of zero samples');
  }
  const rank = Math.ceil((p / 100) * sortedMs.length);
  const index = Math.min(sortedMs.length - 1, Math.max(0, rank - 1));
  return sortedMs[index] ?? first;
}

/** Compares a sample's p95 against a budget. Returns a verdict; the caller decides what to do. */
export function budgetVerdict(sample: PerfSample, budgetMs: number): BudgetVerdict {
  return {
    sample,
    budgetMs,
    pass: sample.p95Ms <= budgetMs,
    headroomPct: ((budgetMs - sample.p95Ms) / budgetMs) * 100,
  };
}

/** A single log line. Written for someone reading a red CI run, not for a dashboard to parse. */
export function formatSample(sample: PerfSample, budgetMs?: number): string {
  const core =
    `${sample.label}: p95 ${round(sample.p95Ms)}ms ` +
    `(p50 ${round(sample.p50Ms)}, min ${round(sample.minMs)}, max ${round(sample.maxMs)}) ` +
    `over ${sample.runs} runs`;
  if (budgetMs === undefined) return core;

  const verdict = budgetVerdict(sample, budgetMs);
  const state = verdict.pass ? 'within' : 'OVER';
  return `${core} — ${state} budget ${budgetMs}ms (${round(verdict.headroomPct)}% headroom)`;
}

/**
 * The budgets, re-exported so a perf test imports one symbol rather than reaching into
 * `shared-types` for the constant and this file for the timer. Same object, not a copy.
 */
export { PERF_BUDGETS };

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Consumes a value so the optimiser cannot elide the call that produced it. Assigning to a
 * module-level binding is enough; nothing reads `lastResult` on purpose.
 */
let lastResult: unknown = null;
function sink(value: unknown): void {
  lastResult = value;
  if (lastResult === Symbol.for('cpm-engine.perf.never')) {
    throw new Error('perf harness: unreachable sink guard');
  }
}
