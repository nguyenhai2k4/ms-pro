import { describe, expect, it } from 'vitest';
import { buildGraph } from './graph.js';
import { topologicalOrder } from './topological-order.js';
import {
  dependencyId,
  makeDependencies,
  makeDependency,
  makeTasks,
  taskId,
} from './test-support/fixtures.js';

function orderOf(
  taskNumbers: readonly number[],
  pairs: readonly (readonly [number, number])[],
): readonly string[] {
  const { graph } = buildGraph(makeTasks(taskNumbers), makeDependencies(pairs));
  const result = topologicalOrder(graph);
  if (result.status !== 'ordered') {
    expect.unreachable(`expected an ordered result, got ${result.status}`);
  }
  return result.order;
}

describe('topologicalOrder — predecessors first (FR-SCH-01)', () => {
  it('orders a diamond so both middle tasks follow the fork and precede the join', () => {
    expect(
      orderOf(
        [1, 2, 3, 4],
        [
          [1, 2],
          [1, 3],
          [2, 4],
          [3, 4],
        ],
      ),
    ).toEqual([taskId(1), taskId(2), taskId(3), taskId(4)]);
  });

  it('lets the graph override the id tie-break', () => {
    // 3 -> 1 forces task 3 ahead of task 1 despite the ids.
    expect(orderOf([1, 2, 3], [[3, 1]])).toEqual([taskId(2), taskId(3), taskId(1)]);
  });

  it('emits isolated tasks in ascending id order', () => {
    expect(orderOf([3, 1, 2], [])).toEqual([taskId(1), taskId(2), taskId(3)]);
  });

  it('takes the smallest ready task, not the first one to become ready', () => {
    // Edges 1->3 and 4->2. After emitting task 1, tasks 3 and 4 are both ready. Taking the
    // smallest gives [1, 3, 4, 2]; a FIFO frontier would give [1, 4, 3, 2] — equally valid
    // topologically, and dependent on the order edges happened to be relaxed in, which is the
    // determinism bug this heap exists to prevent.
    expect(
      orderOf(
        [1, 2, 3, 4],
        [
          [1, 3],
          [4, 2],
        ],
      ),
    ).toEqual([taskId(1), taskId(3), taskId(4), taskId(2)]);
  });

  it('counts parallel edges between the same pair once per edge', () => {
    const { graph } = buildGraph(makeTasks([1, 2]), [
      makeDependency(1, 1, 2, { type: 'FS' }),
      makeDependency(2, 1, 2, { type: 'SS' }),
    ]);
    const result = topologicalOrder(graph);

    // Two edges raise task 2's indegree to 2; decrementing once per edge is what keeps it from
    // being released early — or, if over-decremented, from never being released at all.
    expect(result.status).toBe('ordered');
    expect(result.status === 'ordered' && result.order).toEqual([taskId(1), taskId(2)]);
  });

  it('orders an empty graph without special-casing', () => {
    const result = topologicalOrder(buildGraph([], []).graph);

    expect(result).toEqual({
      status: 'ordered',
      order: [],
      depthByTaskId: new Map(),
      topologicalDepth: 0,
    });
  });
});

describe('topologicalOrder — depth (CpmMetrics.topologicalDepth)', () => {
  it('counts the longest chain of predecessors ending at each task, in nodes', () => {
    const { graph } = buildGraph(
      makeTasks([1, 2, 3, 4]),
      makeDependencies([
        [1, 2],
        [1, 3],
        [2, 4],
        [3, 4],
      ]),
    );
    const result = topologicalOrder(graph);
    if (result.status !== 'ordered') expect.unreachable('expected an ordered result');

    expect([...result.depthByTaskId.entries()]).toEqual([
      [taskId(1), 1],
      [taskId(2), 2],
      [taskId(3), 2],
      [taskId(4), 3],
    ]);
    expect(result.topologicalDepth).toBe(3);
  });

  it('takes the longest path, not the shortest, when a task has two predecessors', () => {
    // 1 -> 2 -> 3 -> 4 and a shortcut 1 -> 4. Task 4's depth is 4 (the long way), not 2.
    const { graph } = buildGraph(
      makeTasks([1, 2, 3, 4]),
      makeDependencies([
        [1, 2],
        [2, 3],
        [3, 4],
        [1, 4],
      ]),
    );
    const result = topologicalOrder(graph);
    if (result.status !== 'ordered') expect.unreachable('expected an ordered result');

    expect(result.depthByTaskId.get(taskId(4))).toBe(4);
    expect(result.topologicalDepth).toBe(4);
  });

  it('reports depth 1 for a graph of nothing but isolated tasks', () => {
    const result = topologicalOrder(buildGraph(makeTasks([1, 2, 3]), []).graph);
    if (result.status !== 'ordered') expect.unreachable('expected an ordered result');

    expect(result.topologicalDepth).toBe(1);
  });
});

describe('topologicalOrder — a cycle is a status, not an exception (FR-SCH-03)', () => {
  it('returns the cycle rather than a partial order', () => {
    const { graph } = buildGraph(
      makeTasks([1, 2, 3]),
      makeDependencies([
        [1, 2],
        [2, 3],
        [3, 1],
      ]),
    );

    const result = topologicalOrder(graph);

    expect(result).toEqual({
      status: 'cyclic',
      cycle: {
        code: 'dependency_cycle',
        severity: 'error',
        cyclePath: [taskId(1), taskId(2), taskId(3), taskId(1)],
        cycleDependencyIds: [dependencyId(1), dependencyId(2), dependencyId(3)],
      },
    });
  });

  it('reports the cycle even when most of the graph is perfectly sortable', () => {
    const { graph } = buildGraph(
      makeTasks([1, 2, 3, 4, 5, 6]),
      makeDependencies([
        [1, 2],
        [2, 3],
        [5, 6],
        [6, 5],
      ]),
    );

    const result = topologicalOrder(graph);

    expect(result.status).toBe('cyclic');
    expect(result.status === 'cyclic' && result.cycle.cyclePath).toEqual([
      taskId(5),
      taskId(6),
      taskId(5),
    ]);
  });
});
