import { describe, expect, it } from 'vitest';
import type { CpmDependency, CpmTask } from '@projectapp/shared-types';
import { buildGraph } from './graph.js';
import { detectCycle } from './cycle.js';
import { topologicalOrder } from './topological-order.js';
import { makeDependencies, makeTasks, taskId } from './test-support/fixtures.js';
import { createSeededRandom, shuffled } from './test-support/random.js';

/**
 * Acceptance (d) — determinism under input permutation (CLAUDE.md invariant 1).
 *
 * The engine's headline guarantee is "same input -> byte-identical output". An input is a *set* of
 * tasks and a *set* of dependencies; the arrays that carry them have an order, but that order is an
 * artefact of however the caller assembled them — a `SELECT` without `ORDER BY`, a `Map` iteration,
 * the order rows came back from a join. If any of that leaks into the output, two API nodes
 * computing the same project can disagree, and the disagreement is invisible until someone compares
 * two exports.
 *
 * So: build one graph, hand it over in 100 shuffled permutations, and require the results to be
 * `JSON.stringify`-identical. Permutations are seeded (see `test-support/random.ts`) so a failure
 * reproduces exactly from the seed printed in this file.
 */

const PERMUTATIONS = 100;
const SEED = 0x5ced_1234;

/**
 * A graph with every structure that has ever leaked input order into an output: a chain, a diamond,
 * a wide fan-out/fan-in, parallel edges, isolated nodes, and — the important one — several edges
 * running from a *high* task id to a *low* one, so the topological order cannot coincidentally
 * equal the id order.
 */
function acyclicFixture(): { tasks: CpmTask[]; dependencies: CpmDependency[] } {
  const tasks = makeTasks(Array.from({ length: 30 }, (_, i) => i + 1));
  const dependencies = makeDependencies([
    // chain
    [1, 2],
    [2, 3],
    [3, 4],
    // diamond
    [5, 6],
    [5, 7],
    [6, 8],
    [7, 8],
    // join the chain to the diamond
    [4, 5],
    [8, 9],
    // fan-out then fan-in
    [10, 11],
    [10, 12],
    [10, 13],
    [11, 14],
    [12, 14],
    [13, 14],
    // parallel edges between one pair
    [14, 15],
    [14, 15],
    // high id -> low id, so id order is not a valid topological order
    [26, 2],
    [27, 1],
    [28, 10],
    [29, 26],
    // a second component
    [16, 17],
    [17, 18],
    [16, 18],
    // tasks 19..25 and 30 are isolated
  ]);
  return { tasks, dependencies };
}

/** Asserts every dependency's predecessor appears before its successor. */
function assertValidTopologicalOrder(
  order: readonly string[],
  dependencies: readonly CpmDependency[],
): void {
  const position = new Map(order.map((id, index) => [id, index]));
  for (const dependency of dependencies) {
    const from = position.get(dependency.predecessorId);
    const to = position.get(dependency.successorId);
    expect(from, `predecessor ${dependency.predecessorId} missing from the order`).toBeDefined();
    expect(to, `successor ${dependency.successorId} missing from the order`).toBeDefined();
    expect(
      (from ?? 0) < (to ?? 0),
      `${dependency.predecessorId} must precede ${dependency.successorId}`,
    ).toBe(true);
  }
}

/** Asserts the reported path really is a loop, and that the named edges really connect it. */
function assertValidCycle(
  cyclePath: readonly string[],
  cycleDependencyIds: readonly string[],
  dependencies: readonly CpmDependency[],
): void {
  expect(cyclePath.length).toBeGreaterThanOrEqual(3);
  expect(cyclePath.at(0)).toBe(cyclePath.at(-1));
  expect(cycleDependencyIds).toHaveLength(cyclePath.length - 1);

  const byId = new Map<string, CpmDependency>(
    dependencies.map((dependency) => [dependency.id, dependency]),
  );
  for (let i = 0; i < cycleDependencyIds.length; i += 1) {
    const edge = byId.get(cycleDependencyIds[i] ?? '');
    expect(edge, `cycleDependencyIds[${i}] is not a dependency in the input`).toBeDefined();
    expect(edge?.predecessorId).toBe(cyclePath[i]);
    expect(edge?.successorId).toBe(cyclePath[i + 1]);
  }
}

describe('determinism under input permutation (acceptance d)', () => {
  it('produces a byte-identical topological order across 100 permutations', () => {
    const { tasks, dependencies } = acyclicFixture();
    const reference = topologicalOrder(buildGraph(tasks, dependencies).graph);
    if (reference.status !== 'ordered') expect.unreachable('fixture must be acyclic');

    assertValidTopologicalOrder(reference.order, dependencies);
    const expected = JSON.stringify(reference.order);
    const nextRandom = createSeededRandom(SEED);

    for (let i = 0; i < PERMUTATIONS; i += 1) {
      const permutedTasks = shuffled(tasks, nextRandom);
      const permutedDependencies = shuffled(dependencies, nextRandom);
      const result = topologicalOrder(buildGraph(permutedTasks, permutedDependencies).graph);

      if (result.status !== 'ordered') expect.unreachable(`permutation ${i} was not orderable`);
      expect(JSON.stringify(result.order), `permutation ${i} produced a different order`).toBe(
        expected,
      );
    }
  });

  it('produces a byte-identical cyclePath across 100 permutations of a cyclic graph', () => {
    const tasks = makeTasks(Array.from({ length: 30 }, (_, i) => i + 1));
    const dependencies = makeDependencies([
      // an acyclic surround, so the search has somewhere else to go first
      [1, 2],
      [2, 3],
      [3, 4],
      [10, 11],
      [11, 12],
      // a loop reached only through task 4
      [4, 7],
      [7, 8],
      [8, 9],
      [9, 7],
      // a second, disjoint loop with lower ids than the first
      [20, 21],
      [21, 20],
    ]);

    const reference = detectCycle(tasks, dependencies);
    expect(reference?.code).toBe('dependency_cycle');
    if (reference?.code !== 'dependency_cycle') expect.unreachable('fixture must be cyclic');

    assertValidCycle(reference.cyclePath, reference.cycleDependencyIds, dependencies);
    const expected = JSON.stringify(reference);
    const nextRandom = createSeededRandom(SEED);

    for (let i = 0; i < PERMUTATIONS; i += 1) {
      const result = detectCycle(shuffled(tasks, nextRandom), shuffled(dependencies, nextRandom));
      expect(JSON.stringify(result), `permutation ${i} reported a different cycle`).toBe(expected);
    }
  });

  it('produces a byte-identical graph structure across 100 permutations', () => {
    // The order itself is not the only output the passes depend on: adjacency order decides the
    // order edges are relaxed in, and once leveling breaks ties on it (FR-RES-06) that becomes
    // schedule-visible. Serialise the whole structure, not just the node order.
    const { tasks, dependencies } = acyclicFixture();
    const serialise = (t: readonly CpmTask[], d: readonly CpmDependency[]): string => {
      const { graph, diagnostics, anomalies } = buildGraph(t, d);
      return JSON.stringify({
        taskIds: graph.taskIds,
        rootTaskIds: graph.rootTaskIds,
        edges: graph.edges.map((edge) => edge.id),
        nodes: graph.nodeList.map((node) => ({
          id: node.task.id,
          index: node.index,
          incoming: node.incoming.map((edge) => edge.id),
          outgoing: node.outgoing.map((edge) => edge.id),
          childIds: node.childIds,
        })),
        diagnostics,
        anomalies,
      });
    };

    const expected = serialise(tasks, dependencies);
    const nextRandom = createSeededRandom(SEED);

    for (let i = 0; i < PERMUTATIONS; i += 1) {
      const actual = serialise(shuffled(tasks, nextRandom), shuffled(dependencies, nextRandom));
      expect(actual, `permutation ${i} produced a different graph`).toBe(expected);
    }
  });

  it('is stable for malformed input too, so a rejection message never varies', () => {
    // Diagnostics are surfaced to the user (FR-SCH-03). "Which broken edge did we name?" must not
    // depend on row order either, or the same failing mutation reports differently on retry.
    const tasks = makeTasks([1, 2, 3]);
    const dependencies = makeDependencies([
      [1, 2],
      [2, 99],
      [3, 3],
      [98, 1],
    ]);

    const expected = JSON.stringify(buildGraph(tasks, dependencies).diagnostics);
    const nextRandom = createSeededRandom(SEED);

    for (let i = 0; i < PERMUTATIONS; i += 1) {
      const actual = JSON.stringify(
        buildGraph(shuffled(tasks, nextRandom), shuffled(dependencies, nextRandom)).diagnostics,
      );
      expect(actual, `permutation ${i} produced different diagnostics`).toBe(expected);
    }
  });

  it('shuffles for real — the guard against a no-op permutation making this vacuous', () => {
    const { tasks } = acyclicFixture();
    const nextRandom = createSeededRandom(SEED);
    const permuted = shuffled(tasks, nextRandom);

    expect(permuted).toHaveLength(tasks.length);
    expect(permuted.map((task) => task.id)).not.toEqual(tasks.map((task) => task.id));
    expect([...permuted].sort((a, b) => (a.id < b.id ? -1 : 1)).map((task) => task.id)).toEqual(
      tasks.map((task) => task.id),
    );
    expect(tasks[0]?.id).toBe(taskId(1));
  });
});
