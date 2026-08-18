import { cpmScheduleInputSchema } from '@projectapp/shared-types';
import type { CpmScheduleInput } from '@projectapp/shared-types';
import { describe, expect, it } from 'vitest';
import { detectCycle } from '../cycle.js';
import { buildGraph } from '../graph.js';
import { topologicalOrder } from '../topological-order.js';
import { makeSyntheticProject } from './synthetic.js';

/**
 * Acceptance (c) — the synthetic generator.
 *
 * Everything W5-1's property tests and W3-1's determinism tests conclude will rest on this
 * generator, so its own three guarantees are tested directly rather than argued for in a comment:
 *
 *  1. **Acyclic at every size**, confirmed by running `detectCycle` over the generator's own output.
 *     A generator that emitted a cycle even occasionally would surface later as a `rejected` result
 *     inside a property test, look exactly like an engine bug, and cost someone a day.
 *  2. **Byte-identical for a given seed**, so a failing property test reproduces from the seed
 *     printed in its output and nothing else.
 *  3. **Schema-valid**, so `computeSchedule(makeSyntheticProject(...))` is a legal call.
 *
 * The sizes are the ones acceptance (c) names — 10, 100, 1000, 5000 — because a generator that is
 * correct at 10 and subtly wrong at 5,000 (an empty layer, an off-by-one in the rank window) is the
 * failure mode that only shows up under the FR-SCH-06 perf run, where it looks like a perf result.
 */

const SIZES = [10, 100, 1000, 5000] as const;
const SEED = 0x5eed_2026;

function edgeCount(input: CpmScheduleInput): number {
  return input.dependencies.length;
}

describe.each(SIZES)('makeSyntheticProject at %i tasks', (taskCount) => {
  const input = makeSyntheticProject({ taskCount, seed: SEED });

  it('produces exactly the requested number of tasks, with unique ids', () => {
    expect(input.tasks).toHaveLength(taskCount);
    expect(new Set(input.tasks.map((task) => task.id)).size).toBe(taskCount);
    expect(new Set(input.dependencies.map((d) => d.id)).size).toBe(edgeCount(input));
  });

  it('parses against cpmScheduleInputSchema unmodified', () => {
    expect(() => cpmScheduleInputSchema.parse(input)).not.toThrow();
  });

  it('is acyclic — checked by running detectCycle, not by trusting the construction', () => {
    expect(detectCycle(input.tasks, input.dependencies)).toBeNull();
  });

  it('builds a graph with no dangling edges and no structural anomalies', () => {
    const { graph, diagnostics, anomalies } = buildGraph(input.tasks, input.dependencies);
    expect(diagnostics).toEqual([]);
    expect(anomalies).toEqual([]);
    expect(graph.nodeList).toHaveLength(taskCount);
    expect(graph.edges).toHaveLength(edgeCount(input));
  });

  it('is byte-identical across two runs with the same seed', () => {
    const again = makeSyntheticProject({ taskCount, seed: SEED });
    expect(JSON.stringify(again)).toBe(JSON.stringify(input));
  });

  it('is different under a different seed — the guard against a constant generator', () => {
    const other = makeSyntheticProject({ taskCount, seed: SEED + 1 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(input));
  });
});

describe('the generated shape is what the options ask for', () => {
  it('hits the requested topological depth exactly', () => {
    // `depth` is a promise, not a hint: every task in layer L > 0 gets a predecessor in layer L - 1,
    // so the longest chain is exactly `depth` nodes. The perf suites correlate runtime against this
    // rather than task count (see topological-order.ts), so an approximate depth would make the
    // perf numbers uninterpretable.
    for (const depth of [1, 2, 5, 12, 40]) {
      const input = makeSyntheticProject({ taskCount: 500, depth, seed: 7 });
      const topology = topologicalOrder(buildGraph(input.tasks, input.dependencies).graph);
      expect(topology.status).toBe('ordered');
      if (topology.status !== 'ordered') continue;
      expect(topology.topologicalDepth, `depth ${depth}`).toBe(depth);
    }
  });

  it('does not let task-id order double as a topological order', () => {
    // If ids ascended with the graph, an engine that simply iterated `tasks` in order would pass
    // every property test built on this generator without ever doing a topological sort.
    const input = makeSyntheticProject({ taskCount: 200, seed: 11 });
    const backwards = input.dependencies.filter((d) => d.predecessorId > d.successorId);
    expect(backwards.length, 'no edge runs from a high task id to a low one').toBeGreaterThan(0);
  });

  it('emits tasks in a shuffled order, so input order cannot be mistaken for meaning', () => {
    const input = makeSyntheticProject({ taskCount: 200, seed: 13 });
    const ids = input.tasks.map((task) => task.id);
    expect(ids).not.toEqual([...ids].sort());
  });

  it('respects avgFanout as a mean in-degree', () => {
    const sparse = makeSyntheticProject({ taskCount: 2000, avgFanout: 1, depth: 20, seed: 17 });
    const dense = makeSyntheticProject({ taskCount: 2000, avgFanout: 4, depth: 20, seed: 17 });
    expect(edgeCount(dense)).toBeGreaterThan(edgeCount(sparse) * 2);
  });

  it('produces manual tasks, constrained tasks and milestones when asked, and none by default', () => {
    const plain = makeSyntheticProject({ taskCount: 500, seed: 19 });
    expect(plain.tasks.every((t) => t.scheduleMode === 'auto')).toBe(true);
    expect(plain.tasks.every((t) => t.constraintType === 'ASAP')).toBe(true);
    expect(plain.tasks.every((t) => !t.isMilestone)).toBe(true);
    expect(plain.tasks.every((t) => t.parentId === null)).toBe(true);

    const rich = makeSyntheticProject({
      taskCount: 500,
      seed: 19,
      summaryRatio: 0.1,
      manualRatio: 0.2,
      constrainedRatio: 0.2,
      milestoneRatio: 0.1,
    });
    expect(() => cpmScheduleInputSchema.parse(rich)).not.toThrow();
    expect(detectCycle(rich.tasks, rich.dependencies)).toBeNull();
    expect(rich.tasks.some((t) => t.scheduleMode === 'manual')).toBe(true);
    expect(rich.tasks.some((t) => t.constraintType !== 'ASAP')).toBe(true);
    expect(rich.tasks.some((t) => t.isMilestone)).toBe(true);
    expect(rich.tasks.some((t) => t.parentId !== null)).toBe(true);

    // A manual task must carry both dates and a dated constraint must carry its date, or
    // cpmTaskSchema's superRefine rejects — which the parse above already proved, but state the
    // rule so a future edit to the generator fails here with a readable message.
    for (const task of rich.tasks) {
      if (task.scheduleMode === 'manual') {
        expect(task.manualStart).not.toBeNull();
        expect(task.manualFinish).not.toBeNull();
      }
      if (task.constraintType !== 'ASAP' && task.constraintType !== 'ALAP') {
        expect(task.constraintDate).not.toBeNull();
      }
    }
  });

  it('never builds a WBS cycle, however many summaries it is asked for', () => {
    const input = makeSyntheticProject({ taskCount: 400, seed: 23, summaryRatio: 0.5 });
    const { anomalies } = buildGraph(input.tasks, input.dependencies);
    expect(anomalies).toEqual([]);
  });

  it('rejects options that cannot describe a graph', () => {
    expect(() => makeSyntheticProject({ taskCount: 0, seed: 1 })).toThrow(RangeError);
    expect(() => makeSyntheticProject({ taskCount: 2.5, seed: 1 })).toThrow(RangeError);
    expect(() => makeSyntheticProject({ taskCount: 10, seed: 1, manualRatio: 1.5 })).toThrow(
      RangeError,
    );
  });

  it('handles the degenerate single-task project without inventing an edge', () => {
    const input = makeSyntheticProject({ taskCount: 1, seed: 29 });
    expect(input.tasks).toHaveLength(1);
    expect(input.dependencies).toEqual([]);
  });
});
