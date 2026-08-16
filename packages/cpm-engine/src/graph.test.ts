import { describe, expect, it } from 'vitest';
import type { CpmDependency, CpmTask } from '@projectapp/shared-types';
import { buildGraph, graphNode } from './graph.js';
import {
  dependencyId,
  makeDependencies,
  makeDependency,
  makeTask,
  makeTasks,
  taskId,
} from './test-support/fixtures.js';

/** Freezes the arrays and every object in them, so any mutation by the engine throws. */
function deepFreeze<T>(items: readonly T[]): readonly T[] {
  for (const item of items) Object.freeze(item);
  return Object.freeze(items);
}

function outgoingIds(
  result: ReturnType<typeof buildGraph>,
  n: number,
): readonly string[] | undefined {
  return graphNode(result.graph, taskId(n))?.outgoing.map((edge) => edge.successorId);
}

function incomingIds(
  result: ReturnType<typeof buildGraph>,
  n: number,
): readonly string[] | undefined {
  return graphNode(result.graph, taskId(n))?.incoming.map((edge) => edge.predecessorId);
}

describe('buildGraph — adjacency in both directions (FR-SCH-01)', () => {
  // A -> B, A -> C, B -> D, C -> D
  const tasks = makeTasks([1, 2, 3, 4]);
  const dependencies = makeDependencies([
    [1, 2],
    [1, 3],
    [2, 4],
    [3, 4],
  ]);

  it('records successors for the forward pass and predecessors for the backward pass', () => {
    const result = buildGraph(tasks, dependencies);

    expect(outgoingIds(result, 1)).toEqual([taskId(2), taskId(3)]);
    expect(outgoingIds(result, 4)).toEqual([]);
    expect(incomingIds(result, 4)).toEqual([taskId(2), taskId(3)]);
    expect(incomingIds(result, 1)).toEqual([]);
  });

  it('indexes nodes in ascending taskId order, with index matching position', () => {
    const { graph } = buildGraph(tasks, dependencies);

    expect(graph.taskIds).toEqual([taskId(1), taskId(2), taskId(3), taskId(4)]);
    expect(graph.nodeList.map((node) => node.index)).toEqual([0, 1, 2, 3]);
    expect(graph.nodeList.map((node) => node.task.id)).toEqual(graph.taskIds);
    expect(graph.nodes.get(taskId(3))?.index).toBe(2);
  });

  it('orders edges ascending by dependencyId regardless of input order', () => {
    const forward = buildGraph(tasks, dependencies);
    const reversed = buildGraph([...tasks].reverse(), [...dependencies].reverse());

    expect(forward.graph.edges.map((edge) => edge.id)).toEqual([
      dependencyId(1),
      dependencyId(2),
      dependencyId(3),
      dependencyId(4),
    ]);
    expect(reversed.graph.edges.map((edge) => edge.id)).toEqual(
      forward.graph.edges.map((edge) => edge.id),
    );
  });

  it('keeps parallel edges between the same pair of tasks, ordered by dependencyId', () => {
    const parallel: CpmDependency[] = [
      makeDependency(7, 1, 2, { type: 'SS' }),
      makeDependency(3, 1, 2, { type: 'FS' }),
      makeDependency(5, 1, 2, { type: 'FF', lagHours: -4 }),
    ];
    const result = buildGraph(makeTasks([1, 2]), parallel);

    expect(graphNode(result.graph, taskId(1))?.outgoing.map((edge) => edge.id)).toEqual([
      dependencyId(3),
      dependencyId(5),
      dependencyId(7),
    ]);
    expect(graphNode(result.graph, taskId(2))?.incoming).toHaveLength(3);
    expect(result.diagnostics).toEqual([]);
  });

  it('handles an empty graph without special-casing', () => {
    const result = buildGraph([], []);

    expect(result.graph.taskIds).toEqual([]);
    expect(result.graph.edges).toEqual([]);
    expect(result.graph.rootTaskIds).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.anomalies).toEqual([]);
  });

  it('does not mutate its inputs (CLAUDE.md invariant 1)', () => {
    const frozenTasks = deepFreeze([...tasks].reverse());
    const frozenDependencies = deepFreeze([...dependencies].reverse());
    const before = JSON.stringify({ frozenTasks, frozenDependencies });

    expect(() => buildGraph(frozenTasks, frozenDependencies)).not.toThrow();
    expect(JSON.stringify({ frozenTasks, frozenDependencies })).toBe(before);
  });
});

describe('buildGraph — malformed edges are diagnostics, never exceptions', () => {
  it('reports a dependency whose predecessor is not in the graph', () => {
    const result = buildGraph(makeTasks([1, 2]), [makeDependency(1, 99, 2)]);

    expect(result.diagnostics).toEqual([
      {
        code: 'dangling_dependency',
        severity: 'error',
        dependencyId: dependencyId(1),
        missingTaskId: taskId(99),
      },
    ]);
    expect(result.graph.edges).toEqual([]);
    expect(graphNode(result.graph, taskId(2))?.incoming).toEqual([]);
  });

  it('reports a dependency whose successor is not in the graph', () => {
    const result = buildGraph(makeTasks([1, 2]), [makeDependency(1, 1, 99)]);

    expect(result.diagnostics[0]?.missingTaskId).toBe(taskId(99));
    expect(result.graph.edges).toEqual([]);
  });

  it('reports a self-link as dangling_dependency, naming the looping task', () => {
    // cpm.ts assigns this meaning to the code explicitly: "or a self-link that slipped past the
    // DB check". `dependency_no_self_link` should make this unreachable in production.
    const result = buildGraph(makeTasks([1, 2]), [makeDependency(1, 2, 2)]);

    expect(result.diagnostics).toEqual([
      {
        code: 'dangling_dependency',
        severity: 'error',
        dependencyId: dependencyId(1),
        missingTaskId: taskId(2),
      },
    ]);
    expect(result.graph.edges).toEqual([]);
    expect(graphNode(result.graph, taskId(2))?.outgoing).toEqual([]);
    expect(graphNode(result.graph, taskId(2))?.incoming).toEqual([]);
  });

  it('emits exactly one diagnostic for an edge that is broken in several ways at once', () => {
    // Both endpoints missing *and* a self-link: still one unusable edge, so one diagnostic.
    const result = buildGraph(makeTasks([1]), [makeDependency(1, 99, 99)]);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.missingTaskId).toBe(taskId(99));
  });

  it('orders diagnostics ascending by dependencyId, independent of input order', () => {
    const broken = [makeDependency(9, 1, 98), makeDependency(2, 97, 1), makeDependency(5, 1, 1)];
    const result = buildGraph(makeTasks([1]), broken);
    const reversed = buildGraph(makeTasks([1]), [...broken].reverse());

    expect(result.diagnostics.map((d) => d.dependencyId)).toEqual([
      dependencyId(2),
      dependencyId(5),
      dependencyId(9),
    ]);
    expect(reversed.diagnostics).toEqual(result.diagnostics);
  });

  it('keeps the good edges when only some are broken', () => {
    const result = buildGraph(makeTasks([1, 2, 3]), [
      makeDependency(1, 1, 2),
      makeDependency(2, 2, 99),
      makeDependency(3, 2, 3),
    ]);

    expect(result.graph.edges.map((edge) => edge.id)).toEqual([dependencyId(1), dependencyId(3)]);
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe('buildGraph — WBS hierarchy (FR-TSK-02)', () => {
  it('collects children per summary task and roots at the top, both ascending', () => {
    const tasks: CpmTask[] = [
      makeTask(1),
      makeTask(2, { parentId: taskId(1) }),
      makeTask(3, { parentId: taskId(1) }),
      makeTask(4, { parentId: taskId(3) }),
      makeTask(5),
    ];
    const { graph } = buildGraph([...tasks].reverse(), []);

    expect(graph.rootTaskIds).toEqual([taskId(1), taskId(5)]);
    expect(graphNode(graph, taskId(1))?.childIds).toEqual([taskId(2), taskId(3)]);
    expect(graphNode(graph, taskId(3))?.childIds).toEqual([taskId(4)]);
    expect(graphNode(graph, taskId(2))?.childIds).toEqual([]);
  });

  it('treats a task with an unknown parent as a root and reports a missing_parent anomaly', () => {
    const result = buildGraph([makeTask(1), makeTask(2, { parentId: taskId(99) })], []);

    expect(result.graph.rootTaskIds).toEqual([taskId(1), taskId(2)]);
    expect(result.anomalies).toEqual([
      { code: 'missing_parent', taskIds: [taskId(2)], dependencyIds: [] },
    ]);
  });

  it('terminates on a parent cycle and reports every task in it', () => {
    // 2 -> 3 -> 4 -> 2 as parents, plus an unrelated well-formed root. A naive upward walk here
    // loops forever, which is why this test exists at all.
    const tasks = [
      makeTask(1),
      makeTask(2, { parentId: taskId(3) }),
      makeTask(3, { parentId: taskId(4) }),
      makeTask(4, { parentId: taskId(2) }),
    ];

    const result = buildGraph(tasks, []);

    expect(result.anomalies).toEqual([
      { code: 'parent_cycle', taskIds: [taskId(2), taskId(3), taskId(4)], dependencyIds: [] },
    ]);
    expect(result.graph.rootTaskIds).toEqual([taskId(1)]);
  });

  it('does not flag a deep but well-formed parent chain', () => {
    const tasks = [
      makeTask(1),
      makeTask(2, { parentId: taskId(1) }),
      makeTask(3, { parentId: taskId(2) }),
      makeTask(4, { parentId: taskId(3) }),
    ];

    expect(buildGraph(tasks, []).anomalies).toEqual([]);
  });
});

describe('buildGraph — duplicated primary keys are reported, not silently merged', () => {
  it('keeps one node per duplicated taskId and reports duplicate_task_id', () => {
    const result = buildGraph([makeTask(1), makeTask(1), makeTask(2)], []);

    expect(result.graph.taskIds).toEqual([taskId(1), taskId(2)]);
    expect(result.anomalies).toEqual([
      { code: 'duplicate_task_id', taskIds: [taskId(1)], dependencyIds: [] },
    ]);
  });

  it('keeps one edge per duplicated dependencyId and reports duplicate_dependency_id', () => {
    const result = buildGraph(makeTasks([1, 2, 3]), [
      makeDependency(1, 1, 2),
      makeDependency(1, 1, 3),
    ]);

    expect(result.graph.edges).toHaveLength(1);
    expect(result.anomalies).toEqual([
      { code: 'duplicate_dependency_id', taskIds: [], dependencyIds: [dependencyId(1)] },
    ]);
  });
});
