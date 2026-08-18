import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/graph.js';
import { topologicalOrder } from '../../src/topological-order.js';
import { makeSyntheticProject } from '../../src/test-support/synthetic.js';
import { budgetVerdict, formatSample, measure, PERF_BUDGETS } from './harness.js';

/**
 * **A harness smoke-test, not an FR-SCH-06 measurement.** Read that twice before quoting the number
 * this prints.
 *
 * FR-SCH-06 budgets *full-project recalculation* — `computeSchedule` — at 500ms p95 over 5,000
 * tasks. `computeSchedule` does not exist yet; W3-1 builds it. What this file proves today is that
 * the harness works end to end at the budgeted size: it can generate a 5,000-task project, time
 * something real from outside the engine, take a p95 over 20 runs, and compare it against
 * `PERF_BUDGETS.fullRecalcMs` — so that when W3-1 swaps `buildGraph` + `topologicalOrder` for
 * `computeSchedule`, nothing about the measurement setup is new or unproven.
 *
 * `buildGraph` + `topologicalOrder` is the right stand-in because it is genuinely the first half of
 * a full recalculation: the passes W3-1 adds walk exactly this graph in exactly this order. Whatever
 * this costs is a *floor* under the eventual real number, and a useful one — if the floor were
 * already most of the budget, that would be worth knowing a work item early. The risk register
 * flags FR-SCH-06 as the budget most likely to slip once calendars and constraints layer on, and a
 * floor is the cheapest early evidence about it.
 *
 * The assertion here is therefore deliberately weak: it checks the stand-in fits inside the *full*
 * budget, which is a sanity bound rather than a gate. W6-2 turns this into a CI gate against the
 * real function; it will call the same `measure`/`budgetVerdict` pair with a different `run`.
 */

const TASK_COUNT = PERF_BUDGETS.fullRecalcTaskCount;
const SEED = 0x9e37_79b9;

describe(`perf harness smoke-test — buildGraph + topologicalOrder at ${TASK_COUNT} tasks`, () => {
  it('measures a p95 and reports it against PERF_BUDGETS.fullRecalcMs', () => {
    const input = makeSyntheticProject({
      taskCount: TASK_COUNT,
      avgFanout: 2,
      depth: 40,
      seed: SEED,
    });

    const sample = measure(
      () => {
        const { graph } = buildGraph(input.tasks, input.dependencies);
        return topologicalOrder(graph);
      },
      { label: `buildGraph+topologicalOrder @${TASK_COUNT}`, runs: 20, warmupRuns: 5 },
    );

    const verdict = budgetVerdict(sample, PERF_BUDGETS.fullRecalcMs);

    // The measured number is the deliverable of this test, so it is printed rather than swallowed.
    // `console.warn` is the allowed channel under the repo's `no-console` rule.
    console.warn(
      `[perf] ${formatSample(sample, PERF_BUDGETS.fullRecalcMs)} (STAND-IN, not FR-SCH-06)`,
    );

    expect(sample.runs).toBe(20);
    expect(sample.p95Ms).toBeGreaterThan(0);
    expect(
      verdict.pass,
      `the graph build alone already exceeds the whole FR-SCH-06 budget: ${formatSample(sample, PERF_BUDGETS.fullRecalcMs)}`,
    ).toBe(true);
  });

  it('measured the graph it thinks it did', () => {
    // A perf number over an accidentally-tiny graph is worse than no perf number. Assert the shape
    // of the input the timing above ran against.
    const input = makeSyntheticProject({
      taskCount: TASK_COUNT,
      avgFanout: 2,
      depth: 40,
      seed: SEED,
    });
    const { graph, diagnostics } = buildGraph(input.tasks, input.dependencies);
    const topology = topologicalOrder(graph);

    expect(diagnostics).toEqual([]);
    expect(graph.nodeList).toHaveLength(TASK_COUNT);
    expect(graph.edges.length).toBeGreaterThan(TASK_COUNT);
    expect(topology.status).toBe('ordered');
    if (topology.status !== 'ordered') return;
    expect(topology.topologicalDepth).toBe(40);
  });
});
