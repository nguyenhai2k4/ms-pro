import type { CpmDependency, DependencyId, DetectCycle, TaskId } from '@projectapp/shared-types';
import type { CpmCycleDiagnostic } from './diagnostics.js';
import type { CpmGraph } from './graph.js';
import { buildGraph, graphNodeIndex } from './graph.js';
import { at } from './invariant.js';

/**
 * FR-SCH-03 — cycle detection.
 *
 * ## Why this is a separate entry point
 *
 * The dependency-create endpoint must reject a cycle *before* it writes the row (ADR-010 §7), and
 * paying for a full schedule computation to answer a yes/no question is the wrong shape. So this
 * takes the raw arrays — including a candidate edge that is not persisted yet — and answers on its
 * own.
 *
 * ## Why depth-first, when the topological sort already detects cycles
 *
 * Kahn's algorithm tells you *that* a cycle exists (nodes are left over) but not *which* one; the
 * residue is the cycle plus everything downstream of it, and FR-SCH-03 asks for "a clear error
 * identifying the cycle", not "a clear error identifying 400 tasks". A depth-first walk carries the
 * path on its stack, so the loop falls out exactly.
 *
 * ## Determinism
 *
 * Two independent choices could have leaked input order into the answer, and both are pinned:
 *
 *  1. **Which cycle is reported**, when a graph contains more than one. Roots are tried in
 *     ascending `taskId` and successors are walked in the canonical adjacency order, both of which
 *     are functions of the graph rather than of the input arrays.
 *  2. **Where the reported cycle starts.** A loop has no intrinsic first element, and the node the
 *     walk happened to enter it from is an artefact of the traversal. The cycle is therefore
 *     **rotated to begin at its lowest `taskId`**, so `cyclePath` names the same loop from the same
 *     place no matter which node the search started at.
 *
 * The walk is iterative rather than recursive on purpose: FR-SCH-06 sizes this engine at 5,000
 * tasks, and a 5,000-deep dependency chain is a legal graph that would put 5,000 frames on the JS
 * stack. A `RangeError` from the runtime is not an acceptable answer to "does this edge create a
 * cycle?".
 */

const WHITE = 0;
const GREY = 1;
const BLACK = 2;

interface Frame {
  readonly index: number;
  /** The edge the walk entered this node by; `null` for a root. */
  readonly entryEdge: CpmDependency | null;
  /** Cursor into the node's canonical `outgoing` list. */
  nextEdge: number;
}

/**
 * Finds one cycle in an already-built graph, or `null` when it is acyclic.
 *
 * The graph's edge set is structurally sound by construction (both endpoints present, no
 * self-links), so this never has to defend against a missing node.
 */
export function findCycle(graph: CpmGraph): CpmCycleDiagnostic | null {
  const nodeCount = graph.nodeList.length;
  const colour: number[] = graph.nodeList.map(() => WHITE);

  for (let root = 0; root < nodeCount; root += 1) {
    if (at(colour, root) !== WHITE) continue;

    const frames: Frame[] = [{ index: root, entryEdge: null, nextEdge: 0 }];
    colour[root] = GREY;

    while (frames.length > 0) {
      const frame = at(frames, frames.length - 1);
      const node = at(graph.nodeList, frame.index);

      if (frame.nextEdge >= node.outgoing.length) {
        colour[frame.index] = BLACK;
        frames.pop();
        continue;
      }

      const edge = at(node.outgoing, frame.nextEdge);
      frame.nextEdge += 1;
      const successor = graphNodeIndex(graph, edge.successorId);

      if (at(colour, successor) === GREY) {
        return describeCycle(graph, frames, successor, edge);
      }
      if (at(colour, successor) === WHITE) {
        colour[successor] = GREY;
        frames.push({ index: successor, entryEdge: edge, nextEdge: 0 });
      }
      // BLACK: fully explored and provably not on the current path — nothing to do.
    }
  }

  return null;
}

/**
 * FR-SCH-03. The contract-conforming entry point.
 *
 * Typed as `DetectCycle` at the declaration rather than annotated on the function, so that any
 * drift between this implementation and `packages/shared-types` is a **compile error here**, not a
 * surprise for the first caller that binds to it.
 *
 * ## Precedence: structural damage is reported before cycles
 *
 * If the graph contains an edge naming a task that is not in `tasks`, or a self-link, that
 * `dangling_dependency` diagnostic is returned in preference to any cycle. Both reject the caller's
 * mutation identically (both are `severity: 'error'`, both are in `CPM_ERROR_DIAGNOSTIC_CODES`), so
 * no caller is misled about *whether* to proceed — but a cycle answer computed over a graph whose
 * edges point at nothing is not an answer worth reporting, and the broken edge is the more
 * actionable finding. In production this is unreachable: `dependency`'s foreign keys and the
 * `dependency_no_self_link` check constraint prevent both.
 */
export const detectCycle: DetectCycle = (tasks, dependencies) => {
  const { graph, diagnostics } = buildGraph(tasks, dependencies);
  const structural = diagnostics[0];
  if (structural !== undefined) return structural;
  return findCycle(graph);
};

/**
 * Turns "the walk is at node `u`, and its edge to `v` found `v` already on the current path" into
 * the diagnostic FR-SCH-03 specifies.
 *
 * The grey portion of the frame stack from `v` onwards is the loop. Each frame after `v` records
 * the edge that entered it, so pairing frame `i`'s node with frame `i + 1`'s entry edge — and the
 * closing edge with the last node — gives nodes and edges in the same traversal order, which is
 * what lets the client highlight the exact arrows without re-deriving them.
 */
function describeCycle(
  graph: CpmGraph,
  frames: readonly Frame[],
  cycleStartIndex: number,
  closingEdge: CpmDependency,
): CpmCycleDiagnostic {
  const from = frames.findIndex((frame) => frame.index === cycleStartIndex);
  if (from < 0) {
    throw new Error(
      'cpm-engine invariant: a grey node was not on the frame stack (this is an engine bug, not bad input)',
    );
  }

  // nodes[i] --edges[i]--> nodes[(i + 1) % length]
  const nodes: TaskId[] = [];
  const edges: CpmDependency[] = [];
  for (let i = from; i < frames.length; i += 1) {
    const frame = at(frames, i);
    nodes.push(at(graph.taskIds, frame.index));
    if (i > from) {
      const entryEdge = frame.entryEdge;
      if (entryEdge === null) {
        throw new Error(
          'cpm-engine invariant: a non-root frame had no entry edge (this is an engine bug, not bad input)',
        );
      }
      edges.push(entryEdge);
    }
  }
  edges.push(closingEdge);

  // Rotate to the lowest task id so the same loop is always reported from the same place. Node
  // indices ascend with task id, so the lowest index is the lowest id.
  let pivot = 0;
  for (let i = 1; i < frames.length - from; i += 1) {
    if (at(frames, from + i).index < at(frames, from + pivot).index) pivot = i;
  }

  const length = nodes.length;
  const cyclePath: TaskId[] = [];
  const cycleDependencyIds: DependencyId[] = [];
  for (let i = 0; i < length; i += 1) {
    cyclePath.push(at(nodes, (pivot + i) % length));
    cycleDependencyIds.push(at(edges, (pivot + i) % length).id);
  }
  // FR-SCH-03: the entry task is repeated at the end, so the loop reads as `[a, b, c, a]`.
  cyclePath.push(at(cyclePath, 0));

  return {
    code: 'dependency_cycle',
    severity: 'error',
    cyclePath,
    cycleDependencyIds,
  };
}
