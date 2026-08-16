import type { CpmDependency, CpmTask, DependencyId, TaskId } from '@projectapp/shared-types';
import type { CpmDanglingDependencyDiagnostic } from './diagnostics.js';
import { at } from './invariant.js';
import { compareDependencies, compareIds, compareIncoming, compareOutgoing } from './ordering.js';

/**
 * The engine's internal graph (FR-SCH-01, FR-TSK-02).
 *
 * `CpmScheduleInput` is a *transport* shape — two flat arrays, in whatever order the caller
 * assembled them. Every pass in this package needs the same three things out of it, so they are
 * built once, here, rather than five times with five subtly different orderings:
 *
 *  - **Adjacency in both directions.** The forward pass (ES/EF) walks successors; the backward pass
 *    (LF/LS) walks predecessors. Building only one direction and reversing it later is how the
 *    backward pass ends up visiting edges in a different order than the forward pass did, which is
 *    a determinism bug that only shows up on graphs with parallel edges.
 *  - **A canonical node order.** `taskIds` ascending, with `node.index` its position, so array-based
 *    passes (indegree counts, float arrays) can be indexed instead of hashed.
 *  - **A structurally sound edge set.** Every edge in `edges` has both endpoints present in `nodes`
 *    and is not a self-link, so no traversal has to re-check. Edges that fail that are reported as
 *    diagnostics and *excluded*, which is what makes "look up the successor node" a total operation
 *    everywhere downstream.
 *
 * Hierarchy (`parentId` -> `childIds`) is here for the same build-it-once reason: FR-TSK-03 rollup
 * is scheduling work that moves into this engine in P2 (ADR-010), and it needs children per summary
 * task. No rollup arithmetic lives here — that is a later work item.
 */

/** One task plus its resolved adjacency. All arrays are in canonical order — see `ordering.ts`. */
export interface CpmGraphNode {
  readonly task: CpmTask;
  /** Position in `CpmGraph.taskIds` / `CpmGraph.nodeList`. Ascending by `taskId`. */
  readonly index: number;
  /** Edges where this task is the **successor**. Ascending by `(predecessorId, dependencyId)`. */
  readonly incoming: readonly CpmDependency[];
  /** Edges where this task is the **predecessor**. Ascending by `(successorId, dependencyId)`. */
  readonly outgoing: readonly CpmDependency[];
  /** FR-TSK-02. Direct children, ascending by `taskId`. Non-empty means this is a summary task. */
  readonly childIds: readonly TaskId[];
}

/**
 * The graph. Every array is in canonical order and is treated as immutable by every consumer;
 * `readonly` states that at the type level rather than paying to deep-freeze 5k nodes on the hot
 * path. Nothing in this package mutates a `CpmGraph` after `buildGraph` returns it.
 */
export interface CpmGraph {
  /** Ascending. `taskIds[i] === nodeList[i].task.id`. */
  readonly taskIds: readonly TaskId[];
  /** Ascending by `taskId`. `nodeList[i].index === i`. */
  readonly nodeList: readonly CpmGraphNode[];
  readonly nodes: ReadonlyMap<TaskId, CpmGraphNode>;
  /**
   * Structurally valid edges only, ascending by `dependencyId`. An edge that produced a
   * `dangling_dependency` diagnostic is **absent** — see the file docstring.
   */
  readonly edges: readonly CpmDependency[];
  /**
   * FR-TSK-02. Tasks with no parent, ascending. A task whose `parentId` names a task that is not in
   * the input is treated as a root here (and reported as a `missing_parent` anomaly), so that a
   * top-down walk of the hierarchy still reaches every node.
   */
  readonly rootTaskIds: readonly TaskId[];
}

/**
 * Input-integrity problems that `CpmDiagnostic` has **no code for**.
 *
 * This type is engine-local and is deliberately *not* a `CpmDiagnostic`. The contract's diagnostic
 * union covers bad *edges* (`dangling_dependency`) and bad *calendars*, but has nothing for a
 * duplicated primary key or a malformed WBS hierarchy — `dangling_dependency` requires a
 * `dependencyId`, and a task that is its own ancestor has no dependency to name.
 *
 * Rather than bend an existing code to a meaning it does not have, or quietly ignore the condition,
 * these are reported on a separate channel and **escalated**: if FR-TSK-03's rollup needs a
 * malformed hierarchy to reach the API as a rejection, that is a `packages/shared-types` change and
 * a tech-lead decision (CLAUDE.md invariant 7), not something this package should invent.
 *
 * All of these are caller-side bugs that the database already prevents (`task` primary key,
 * `dependency` foreign keys, the parent-chain check). They are detected because a graph builder
 * that silently drops a duplicate row produces a plausible-looking wrong schedule.
 */
export interface CpmGraphAnomaly {
  readonly code: CpmGraphAnomalyCode;
  /** Ascending. The tasks involved; empty when the anomaly is not about tasks. */
  readonly taskIds: readonly TaskId[];
  /** Ascending. The dependencies involved; empty when the anomaly is not about dependencies. */
  readonly dependencyIds: readonly DependencyId[];
}

export type CpmGraphAnomalyCode =
  /** The same `taskId` appeared twice in `tasks`. The first occurrence is kept. */
  | 'duplicate_task_id'
  /** The same `dependencyId` appeared twice in `dependencies`. The first occurrence is kept. */
  | 'duplicate_dependency_id'
  /** FR-TSK-02: `parentId` names a task that is not in `tasks`. The child is treated as a root. */
  | 'missing_parent'
  /** FR-TSK-02: a task is its own ancestor. Listed tasks are unreachable from `rootTaskIds`. */
  | 'parent_cycle';

export interface CpmGraphBuildResult {
  readonly graph: CpmGraph;
  /**
   * Error-severity `dangling_dependency` diagnostics, ascending by `dependencyId` — the canonical
   * `(code, primary id)` order `cpm.ts` specifies. Non-empty means the computation must be
   * `rejected`; these are never warnings.
   */
  readonly diagnostics: readonly CpmDanglingDependencyDiagnostic[];
  /** See `CpmGraphAnomaly`. Ordered by code, in the order the codes are declared above. */
  readonly anomalies: readonly CpmGraphAnomaly[];
}

/**
 * Builds the graph. **Pure**: the inputs are read, never mutated, and the result depends only on
 * the *set* of tasks and dependencies, never on the order the arrays arrived in.
 *
 * Never throws on malformed input. A bad edge becomes a diagnostic, a bad row becomes an anomaly,
 * and the graph that comes back is always safe to traverse.
 */
export function buildGraph(
  tasks: readonly CpmTask[],
  dependencies: readonly CpmDependency[],
): CpmGraphBuildResult {
  // ---- Tasks: canonical order, first-wins on a duplicated primary key. -------------------------
  const sortedTasks = [...tasks].sort((a, b) => compareIds(a.id, b.id));
  const indexById = new Map<TaskId, number>();
  const uniqueTasks: CpmTask[] = [];
  const duplicateTaskIds = new Set<TaskId>();

  for (const task of sortedTasks) {
    if (indexById.has(task.id)) {
      duplicateTaskIds.add(task.id);
      continue;
    }
    indexById.set(task.id, uniqueTasks.length);
    uniqueTasks.push(task);
  }

  const taskCount = uniqueTasks.length;
  const taskIds = uniqueTasks.map((task) => task.id);

  // ---- Dependencies: canonical order, endpoints resolved, bad edges excluded. ------------------
  const sortedDependencies = [...dependencies].sort(compareDependencies);
  const seenDependencyIds = new Set<DependencyId>();
  const duplicateDependencyIds = new Set<DependencyId>();
  const diagnostics: CpmDanglingDependencyDiagnostic[] = [];
  const edges: CpmDependency[] = [];
  const incoming: CpmDependency[][] = uniqueTasks.map(() => []);
  const outgoing: CpmDependency[][] = uniqueTasks.map(() => []);

  for (const dependency of sortedDependencies) {
    if (seenDependencyIds.has(dependency.id)) {
      duplicateDependencyIds.add(dependency.id);
      continue;
    }
    seenDependencyIds.add(dependency.id);

    const missingTaskId = unusableEndpoint(dependency, indexById);
    if (missingTaskId !== null) {
      diagnostics.push({
        code: 'dangling_dependency',
        severity: 'error',
        dependencyId: dependency.id,
        missingTaskId,
      });
      continue;
    }

    edges.push(dependency);
    at(outgoing, requireIndex(indexById, dependency.predecessorId)).push(dependency);
    at(incoming, requireIndex(indexById, dependency.successorId)).push(dependency);
  }

  for (const list of outgoing) list.sort(compareOutgoing);
  for (const list of incoming) list.sort(compareIncoming);

  // ---- Hierarchy (FR-TSK-02). ------------------------------------------------------------------
  const childIds: TaskId[][] = uniqueTasks.map(() => []);
  const parentIndexOf: number[] = uniqueTasks.map(() => NO_PARENT);
  const rootTaskIds: TaskId[] = [];
  const missingParentTaskIds: TaskId[] = [];

  // `uniqueTasks` is already ascending by id, so `childIds` and `rootTaskIds` come out ascending
  // without a second sort.
  for (let index = 0; index < taskCount; index += 1) {
    const task = at(uniqueTasks, index);
    if (task.parentId === null) {
      rootTaskIds.push(task.id);
      continue;
    }
    const parentIndex = indexById.get(task.parentId);
    if (parentIndex === undefined) {
      missingParentTaskIds.push(task.id);
      rootTaskIds.push(task.id);
      continue;
    }
    parentIndexOf[index] = parentIndex;
    at(childIds, parentIndex).push(task.id);
  }

  const parentCycleTaskIds = findParentCycles(taskIds, parentIndexOf);

  // ---- Assemble. -------------------------------------------------------------------------------
  const nodeList: CpmGraphNode[] = uniqueTasks.map((task, index) => ({
    task,
    index,
    incoming: at(incoming, index),
    outgoing: at(outgoing, index),
    childIds: at(childIds, index),
  }));

  const nodes = new Map<TaskId, CpmGraphNode>();
  for (const node of nodeList) nodes.set(node.task.id, node);

  const anomalies: CpmGraphAnomaly[] = [];
  if (duplicateTaskIds.size > 0) {
    anomalies.push(anomaly('duplicate_task_id', sortIds([...duplicateTaskIds]), []));
  }
  if (duplicateDependencyIds.size > 0) {
    anomalies.push(anomaly('duplicate_dependency_id', [], sortIds([...duplicateDependencyIds])));
  }
  if (missingParentTaskIds.length > 0) {
    anomalies.push(anomaly('missing_parent', sortIds(missingParentTaskIds), []));
  }
  if (parentCycleTaskIds.length > 0) {
    anomalies.push(anomaly('parent_cycle', parentCycleTaskIds, []));
  }

  return {
    graph: { taskIds, nodeList, nodes, edges, rootTaskIds },
    diagnostics,
    anomalies,
  };
}

/** Convenience lookup used across the passes. Returns `undefined` for an id not in the graph. */
export function graphNode(graph: CpmGraph, taskId: TaskId): CpmGraphNode | undefined {
  return graph.nodes.get(taskId);
}

/**
 * The node index for a task id known to be in the graph. Every edge in `graph.edges` has both
 * endpoints present by construction, so callers walking edges may use this directly.
 */
export function graphNodeIndex(graph: CpmGraph, taskId: TaskId): number {
  const node = graph.nodes.get(taskId);
  if (node === undefined) {
    throw new RangeError(
      `cpm-engine invariant: task ${taskId} is not in the graph (this is an engine bug, not bad input)`,
    );
  }
  return node.index;
}

const NO_PARENT = -1;

/**
 * Decides whether an edge is usable, and if not, which task id to name in the diagnostic.
 *
 * At most one diagnostic per dependency — an edge is either usable or it is not, and emitting two
 * for one row would make the diagnostic list depend on how many ways a single row is broken. The
 * check order (predecessor, then successor, then self-link) is fixed so the answer is deterministic
 * when a row is broken in more than one way.
 *
 * The self-link case reuses `dangling_dependency` because `cpm.ts` explicitly assigns it that
 * meaning ("or a self-link that slipped past the DB check"). Nothing is actually missing, so
 * `missingTaskId` names the task on both ends of the loop — which is the only id the client needs
 * in order to highlight it.
 */
function unusableEndpoint(
  dependency: CpmDependency,
  indexById: ReadonlyMap<TaskId, number>,
): TaskId | null {
  if (!indexById.has(dependency.predecessorId)) return dependency.predecessorId;
  if (!indexById.has(dependency.successorId)) return dependency.successorId;
  if (dependency.predecessorId === dependency.successorId) return dependency.predecessorId;
  return null;
}

/**
 * FR-TSK-02. Finds every task that is its own ancestor.
 *
 * The parent relation is a functional graph (each node has at most one parent), so this is a
 * single upward walk per node with three-colour memoisation: O(n) total, and — the part that
 * matters — it **terminates** on a malformed hierarchy instead of looping. Tasks in a parent cycle
 * are unreachable from `rootTaskIds`, so any later top-down rollup would silently skip them; that
 * is why they are reported rather than left to be discovered as missing output rows.
 */
function findParentCycles(taskIds: readonly TaskId[], parentIndexOf: readonly number[]): TaskId[] {
  const UNKNOWN = 0;
  const PENDING = 1;
  const RESOLVED = 2;

  const state: number[] = taskIds.map(() => UNKNOWN);
  const inCycle = new Set<TaskId>();

  for (let start = 0; start < taskIds.length; start += 1) {
    if (at(state, start) !== UNKNOWN) continue;

    const path: number[] = [];
    let current = start;
    for (;;) {
      const currentState = at(state, current);
      if (currentState === PENDING) {
        // Closed a loop within *this* walk: everything from the first sighting onward is in it.
        const from = path.indexOf(current);
        for (let k = from; k < path.length; k += 1) {
          inCycle.add(at(taskIds, at(path, k)));
        }
        break;
      }
      if (currentState === RESOLVED) break;

      state[current] = PENDING;
      path.push(current);

      const parent = at(parentIndexOf, current);
      if (parent === NO_PARENT) break;
      current = parent;
    }

    for (const index of path) state[index] = RESOLVED;
  }

  return sortIds([...inCycle]);
}

function anomaly(
  code: CpmGraphAnomalyCode,
  taskIds: readonly TaskId[],
  dependencyIds: readonly DependencyId[],
): CpmGraphAnomaly {
  return { code, taskIds, dependencyIds };
}

function sortIds<T extends string>(ids: readonly T[]): T[] {
  return [...ids].sort(compareIds);
}

/** The index of a task id that was just checked to be present. See `invariant.ts` for the rule. */
function requireIndex(indexById: ReadonlyMap<TaskId, number>, taskId: TaskId): number {
  const index = indexById.get(taskId);
  if (index === undefined) {
    throw new RangeError(
      `cpm-engine invariant: task ${taskId} has no node index (this is an engine bug, not bad input)`,
    );
  }
  return index;
}
