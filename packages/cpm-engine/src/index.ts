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
 * ## What is here (P2 work item W1-3: FR-SCH-07, FR-TSK-04/07, FR-CAL-01/02)
 *
 *  - `instant.ts` — UTC instant arithmetic in integer epoch milliseconds, including the ISO-8601
 *    conversion that turns the contract's `IsoDateTime` strings into something a pass can compare.
 *    No `Date`, hence no host time zone, hence ADR-011 honoured by construction.
 *  - `calendar.ts` — the working-time kernel: `compileCalendar`, `isWorkingInstant`,
 *    `addWorkingHours` (forward *and*, for FR-SCH-02's lead, backward) and `workingHoursBetween`.
 *    A calendar with no recurring working time never compiles, so the "advance to the next working
 *    minute" walk cannot be handed one it could not terminate on.
 *
 * ## What is deliberately not here yet
 *
 *  - The **forward/backward passes** (FR-SCH-04/05) with constraint and manual-mode handling
 *    (FR-TSK-05/06, FR-SCH-08). A separate work item, dispatched against the graph and the calendar
 *    kernel in this package.
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
export type {
  CpmCycleDiagnostic,
  CpmDanglingDependencyDiagnostic,
  CpmUnusableCalendarDiagnostic,
} from './diagnostics.js';

export {
  MINUTES_PER_DAY,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  civilFromDays,
  daysFromCivil,
  floorDiv,
  floorMod,
  formatIsoDate,
  formatIsoDateTime,
  isoWeekdayOfDay,
  msWithinUtcDay,
  parseIsoDate,
  parseIsoDateTime,
  startOfUtcDay,
  utcDayNumber,
} from './instant.js';
export type { CivilDate, UtcDayNumber, UtcInstant } from './instant.js';

export {
  addWorkingHours,
  addWorkingMilliseconds,
  compileCalendar,
  isWorkingInstant,
  nextWorkingInstant,
  workingHoursBetween,
  workingMillisecondsBetween,
  workingWindowOnDay,
} from './calendar.js';
export type { CompiledCalendar, WorkingTimeCalendar, WorkingWindow } from './calendar.js';

export {
  compareDependencies,
  compareIds,
  compareIncoming,
  compareNumbers,
  compareOutgoing,
} from './ordering.js';
