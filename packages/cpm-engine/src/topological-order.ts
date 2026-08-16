import type { TaskId } from '@projectapp/shared-types';
import { findCycle } from './cycle.js';
import type { CpmCycleDiagnostic } from './diagnostics.js';
import type { CpmGraph } from './graph.js';
import { graphNodeIndex } from './graph.js';
import { at } from './invariant.js';
import { IndexMinHeap } from './ordering.js';

/**
 * Deterministic topological ordering (FR-SCH-01, FR-SCH-04).
 *
 * The forward pass visits tasks in this order; the backward pass visits its reverse. Both are
 * correct for *any* topological order — a node's predecessors all precede it, which is the only
 * property the passes need — so the specific order chosen here is a **determinism** decision, not a
 * correctness one.
 *
 * ## The order
 *
 * Kahn's algorithm, always taking the **smallest ready `taskId`**. That yields the
 * lexicographically smallest of all valid topological orders, which has the property invariant 1
 * needs: it is a function of the graph alone. Permuting `input.tasks` or `input.dependencies`
 * cannot change it, because the frontier is selected by id rather than by arrival.
 *
 * The alternative — a plain FIFO queue — is equally valid topologically and quietly wrong here: the
 * queue's contents depend on the order edges were relaxed in, so the same project would produce two
 * different orders and, once leveling's float tie-breaks depend on it (FR-RES-06, ADR-005), two
 * different schedules.
 *
 * ## Depth
 *
 * `depthByTaskId` is the longest chain of dependencies ending at a task, counted in nodes: 1 for a
 * task with no predecessors. `topologicalDepth` is its maximum, which is what
 * `CpmMetrics.topologicalDepth` reports and what the perf suites should correlate runtime against —
 * a 5,000-task graph 3 levels deep and a 5,000-task chain are very different computations.
 */

export interface OrderedTopology {
  readonly status: 'ordered';
  /** Every task in the graph exactly once, predecessors first. */
  readonly order: readonly TaskId[];
  readonly depthByTaskId: ReadonlyMap<TaskId, number>;
  /** `max(depthByTaskId)`, or 0 for an empty graph. */
  readonly topologicalDepth: number;
}

export interface CyclicTopology {
  readonly status: 'cyclic';
  /** FR-SCH-03. The loop that made ordering impossible, ready to reject with. */
  readonly cycle: CpmCycleDiagnostic;
}

/**
 * Ordered, or the cycle that prevents it. A discriminated union rather than a thrown error or a
 * partial array: a caller that forgets to check `status` gets a compile error, and there is no
 * shape in which a half-ordered graph can be mistaken for a complete one.
 */
export type TopologicalOrderResult = OrderedTopology | CyclicTopology;

/** Pure. Reads the graph, mutates nothing, and returns the same order for the same graph. */
export function topologicalOrder(graph: CpmGraph): TopologicalOrderResult {
  const nodeCount = graph.nodeList.length;
  const remainingPredecessors = graph.nodeList.map((node) => node.incoming.length);
  const depthByIndex: number[] = graph.nodeList.map(() => 0);

  const ready = new IndexMinHeap();
  for (let index = 0; index < nodeCount; index += 1) {
    if (at(remainingPredecessors, index) === 0) ready.push(index);
  }

  const order: TaskId[] = [];
  const depthByTaskId = new Map<TaskId, number>();

  for (let next = ready.pop(); next !== undefined; next = ready.pop()) {
    const node = at(graph.nodeList, next);

    // Every predecessor has already been emitted — that is what an indegree of zero means — so
    // its depth is final and this is a single pass, not a fixed point.
    let depth = 1;
    for (const edge of node.incoming) {
      const predecessorDepth = at(depthByIndex, graphNodeIndex(graph, edge.predecessorId));
      if (predecessorDepth + 1 > depth) depth = predecessorDepth + 1;
    }
    depthByIndex[next] = depth;

    order.push(node.task.id);
    depthByTaskId.set(node.task.id, depth);

    for (const edge of node.outgoing) {
      const successor = graphNodeIndex(graph, edge.successorId);
      const remaining = at(remainingPredecessors, successor) - 1;
      remainingPredecessors[successor] = remaining;
      if (remaining === 0) ready.push(successor);
    }
  }

  if (order.length !== nodeCount) {
    // Nodes left with a non-zero indegree can only be a cycle or downstream of one. `findCycle`
    // names the loop itself, which is what FR-SCH-03 requires the error to identify.
    const cycle = findCycle(graph);
    if (cycle === null) {
      throw new Error(
        'cpm-engine invariant: topological sort stalled on an acyclic graph (this is an engine bug, not bad input)',
      );
    }
    return { status: 'cyclic', cycle };
  }

  let topologicalDepth = 0;
  for (const depth of depthByIndex) {
    if (depth > topologicalDepth) topologicalDepth = depth;
  }

  return { status: 'ordered', order, depthByTaskId, topologicalDepth };
}
