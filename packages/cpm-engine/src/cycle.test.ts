import { describe, expect, it } from 'vitest';
import type { CpmDependency, CpmTask, DetectCycle } from '@projectapp/shared-types';
import { detectCycle, findCycle } from './cycle.js';
import { buildGraph } from './graph.js';
import {
  dependencyId,
  makeDependencies,
  makeDependency,
  makeTask,
  makeTasks,
  taskId,
} from './test-support/fixtures.js';

/**
 * Acceptance (b): the implementation is assignable to the contract's `DetectCycle`.
 *
 * `cycle.ts` already declares `detectCycle` with that type, so this is the second, independent
 * guard: if someone widens or narrows the declaration there, this assignment stops compiling and
 * `pnpm typecheck` fails. A signature drift becomes a build error for the author of the change
 * rather than a runtime surprise for whoever binds to it next.
 */
const contractDetectCycle: DetectCycle = detectCycle;

/** Fails the test rather than the run if the engine throws — acceptance (e). */
function detectWithoutThrowing(
  tasks: readonly CpmTask[],
  dependencies: readonly CpmDependency[],
): ReturnType<DetectCycle> {
  try {
    return contractDetectCycle(tasks, dependencies);
  } catch (error) {
    expect.unreachable(
      `detectCycle threw instead of returning a diagnostic: ${String(error)}. An engine that ` +
        'throws on malformed input turns a user mistake into a 500 for its caller.',
    );
  }
}

describe('detectCycle — FR-SCH-03', () => {
  it('is assignable to the contract type and is a two-argument function', () => {
    expect(typeof contractDetectCycle).toBe('function');
    expect(contractDetectCycle.length).toBe(2);
  });

  it('returns null for a diamond DAG (A->B, A->C, B->D, C->D)', () => {
    const result = contractDetectCycle(
      makeTasks([1, 2, 3, 4]),
      makeDependencies([
        [1, 2],
        [1, 3],
        [2, 4],
        [3, 4],
      ]),
    );

    expect(result).toBeNull();
  });

  it('returns null for an empty graph and for a graph with no dependencies', () => {
    expect(contractDetectCycle([], [])).toBeNull();
    expect(contractDetectCycle(makeTasks([1, 2, 3]), [])).toBeNull();
  });

  it('names the loop for A->B->C->D->A, entry task repeated at the end', () => {
    const result = contractDetectCycle(
      makeTasks([1, 2, 3, 4]),
      makeDependencies([
        [1, 2],
        [2, 3],
        [3, 4],
        [4, 1],
      ]),
    );

    expect(result).toEqual({
      code: 'dependency_cycle',
      severity: 'error',
      cyclePath: [taskId(1), taskId(2), taskId(3), taskId(4), taskId(1)],
      cycleDependencyIds: [dependencyId(1), dependencyId(2), dependencyId(3), dependencyId(4)],
    });
  });

  it('names the two edges of a two-task cycle', () => {
    const result = contractDetectCycle(
      makeTasks([1, 2]),
      makeDependencies([
        [1, 2],
        [2, 1],
      ]),
    );

    expect(result).toEqual({
      code: 'dependency_cycle',
      severity: 'error',
      cyclePath: [taskId(1), taskId(2), taskId(1)],
      cycleDependencyIds: [dependencyId(1), dependencyId(2)],
    });
  });

  it('reports only the loop, not the acyclic tail that leads into it', () => {
    // 1 -> 3, and the cycle 3 -> 4 -> 5 -> 3. Task 1 is upstream of the loop but not in it;
    // FR-SCH-03 asks the error to identify the cycle, not everything downstream of the search.
    const result = contractDetectCycle(
      makeTasks([1, 2, 3, 4, 5]),
      makeDependencies([
        [1, 3],
        [3, 4],
        [4, 5],
        [5, 3],
      ]),
    );

    expect(result).toEqual({
      code: 'dependency_cycle',
      severity: 'error',
      cyclePath: [taskId(3), taskId(4), taskId(5), taskId(3)],
      cycleDependencyIds: [dependencyId(2), dependencyId(3), dependencyId(4)],
    });
  });

  it('rotates the reported loop to its lowest taskId, whichever node the search entered by', () => {
    // The walk starts at task 1 (lowest id) and enters the loop at task 3, so the raw traversal
    // would read [3, 2, 3]. Rotating to the lowest member makes the report a property of the loop
    // rather than of the search.
    const result = contractDetectCycle(
      makeTasks([1, 2, 3]),
      makeDependencies([
        [1, 3],
        [3, 2],
        [2, 3],
      ]),
    );

    expect(result).toEqual({
      code: 'dependency_cycle',
      severity: 'error',
      cyclePath: [taskId(2), taskId(3), taskId(2)],
      cycleDependencyIds: [dependencyId(3), dependencyId(2)],
    });
  });

  it('answers a not-yet-persisted candidate edge, which is why it is a separate entry point', () => {
    // ADR-010 §7: the dependency-create endpoint asks before it writes the row.
    const tasks = makeTasks([1, 2, 3]);
    const persisted = makeDependencies([
      [1, 2],
      [2, 3],
    ]);
    const candidate = makeDependency(3, 3, 1);

    expect(contractDetectCycle(tasks, persisted)).toBeNull();
    expect(contractDetectCycle(tasks, [...persisted, candidate])).not.toBeNull();
  });
});

describe('detectCycle — malformed input is a diagnostic, never an exception (acceptance e)', () => {
  it('returns a dangling_dependency diagnostic for an edge naming an absent task', () => {
    const result = detectWithoutThrowing(makeTasks([1, 2]), [makeDependency(1, 1, 99)]);

    expect(result).toEqual({
      code: 'dangling_dependency',
      severity: 'error',
      dependencyId: dependencyId(1),
      missingTaskId: taskId(99),
    });
  });

  it('returns a dangling_dependency diagnostic for a self-link instead of looping', () => {
    const result = detectWithoutThrowing(makeTasks([1, 2]), [makeDependency(1, 1, 1)]);

    expect(result).toEqual({
      code: 'dangling_dependency',
      severity: 'error',
      dependencyId: dependencyId(1),
      missingTaskId: taskId(1),
    });
  });

  it('does not throw on a graph that is dangling, self-linked and cyclic at once', () => {
    const result = detectWithoutThrowing(makeTasks([1, 2, 3]), [
      makeDependency(1, 1, 2),
      makeDependency(2, 2, 1),
      makeDependency(3, 3, 3),
      makeDependency(4, 3, 99),
    ]);

    // Structural damage outranks the cycle: both reject the caller's mutation, and a cycle answer
    // computed over edges that point at nothing is not worth reporting.
    expect(result?.code).toBe('dangling_dependency');
  });

  it('does not throw on a malformed hierarchy, a duplicate id, or an empty task list', () => {
    expect(() => contractDetectCycle([makeTask(1, { parentId: taskId(1) })], [])).not.toThrow();
    expect(() => contractDetectCycle([makeTask(1), makeTask(1)], [])).not.toThrow();
    expect(() => contractDetectCycle([], [makeDependency(1, 1, 2)])).not.toThrow();
  });
});

describe('findCycle — operates on an already-built graph', () => {
  it('finds a cycle among several disjoint components', () => {
    const { graph } = buildGraph(
      makeTasks([1, 2, 3, 4, 5, 6]),
      makeDependencies([
        [1, 2],
        [3, 4],
        [5, 6],
        [6, 5],
      ]),
    );

    expect(findCycle(graph)).toEqual({
      code: 'dependency_cycle',
      severity: 'error',
      cyclePath: [taskId(5), taskId(6), taskId(5)],
      cycleDependencyIds: [dependencyId(3), dependencyId(4)],
    });
  });

  it('does not mistake a re-converging DAG for a cycle, however wide', () => {
    // A wide diamond: 1 fans out to 2..9, all of which converge on 10. Every one of 2..9 is
    // reachable twice from the search's point of view, which is the classic false positive.
    const fanOut = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => [1, n] as const);
    const fanIn = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, 10] as const);
    const { graph } = buildGraph(
      makeTasks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      makeDependencies([...fanOut, ...fanIn]),
    );

    expect(findCycle(graph)).toBeNull();
  });

  it('handles a 5,000-task chain without overflowing the JS stack (FR-SCH-06 sizing)', () => {
    const numbers = Array.from({ length: 5000 }, (_, i) => i + 1);
    const pairs = numbers.slice(1).map((n) => [n - 1, n] as const);
    const { graph } = buildGraph(makeTasks(numbers), makeDependencies(pairs));

    expect(findCycle(graph)).toBeNull();
  });

  it('finds the loop when a 5,000-task chain is closed back on itself', () => {
    const numbers = Array.from({ length: 5000 }, (_, i) => i + 1);
    const pairs: (readonly [number, number])[] = numbers.slice(1).map((n) => [n - 1, n] as const);
    pairs.push([5000, 1]);
    const { graph } = buildGraph(makeTasks(numbers), makeDependencies(pairs));

    const cycle = findCycle(graph);
    expect(cycle?.cyclePath).toHaveLength(5001);
    expect(cycle?.cyclePath.at(0)).toBe(taskId(1));
    expect(cycle?.cyclePath.at(-1)).toBe(taskId(1));
    expect(cycle?.cycleDependencyIds).toHaveLength(5000);
  });
});
