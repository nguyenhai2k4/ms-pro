/**
 * `@projectapp/cpm-engine` — the pure CPM core (CLAUDE.md invariant 1, ADR-010).
 *
 * Graph + calendars + constraints in, schedule out. No DB access, no network, no clock reads, no
 * randomness, no mutation of inputs. Purity is enforced three ways, none of which is code review:
 * the contract's function types are **synchronous** (`packages/shared-types/src/cpm.ts`), the
 * `packages/cpm-engine` block in `eslint.config.mjs` makes `Date`, `Math.random`, `fetch` and
 * `node:*`/`pg`/`ioredis` imports lint errors in `src/`, and `src/purity.test.ts` scans this
 * directory independently so the guarantee survives someone loosening the lint config.
 *
 * ## What is here (P2 work item W1-1: FR-SCH-01, FR-SCH-03, FR-TSK-02)
 *
 *  - `buildGraph` — the two flat input arrays turned into bidirectional adjacency plus WBS
 *    hierarchy, with malformed edges reported as diagnostics instead of thrown.
 *  - `topologicalOrder` — the deterministic order the scheduling passes walk.
 *  - `detectCycle` / `findCycle` — FR-SCH-03, exposed on its own so the dependency-create endpoint
 *    can reject before it writes a row.
 *
 * ## What is deliberately not here yet
 *
 *  - **The calendar kernel** (FR-SCH-07, FR-CAL-01..04) and the **forward/backward passes**
 *    (FR-SCH-04/05) with constraint and manual-mode handling (FR-TSK-05/06, FR-SCH-08). Separate
 *    work items, dispatched against the graph in this file.
 *  - `computeSchedule` / `recomputeSchedule`. The `ComputeSchedule` and `RecomputeSchedule` types
 *    exist in the contract; nothing here implements them yet, and an export that returned an empty
 *    schedule would be worse than an absent one.
 *  - Resource leveling (FR-RES-05/06) — P4.
 */

export { buildGraph, graphNode, graphNodeIndex } from './graph.js';
export type {
  CpmGraph,
  CpmGraphAnomaly,
  CpmGraphAnomalyCode,
  CpmGraphBuildResult,
  CpmGraphNode,
} from './graph.js';

export { topologicalOrder } from './topological-order.js';
export type {
  CyclicTopology,
  OrderedTopology,
  TopologicalOrderResult,
} from './topological-order.js';

export { detectCycle, findCycle } from './cycle.js';
export type { CpmCycleDiagnostic, CpmDanglingDependencyDiagnostic } from './diagnostics.js';

export {
  compareDependencies,
  compareIds,
  compareIncoming,
  compareNumbers,
  compareOutgoing,
} from './ordering.js';
