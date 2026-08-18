import type { CpmDiagnostic } from '@projectapp/shared-types';

/**
 * Narrowed aliases for the arms of `CpmDiagnostic`.
 *
 * `packages/shared-types/src/cpm.ts` exports each arm's zod schema but only the *union* as a TS
 * type, so there is no `CpmCycleDiagnostic` to import. Deriving the arms with `Extract` rather than
 * re-declaring their shape is deliberate: these stay structurally identical to the contract by
 * construction, so a field added to `cpmCycleDiagnosticSchema` upstream becomes a compile error
 * here rather than a second, drifting definition of the same object. It also keeps this package's
 * imports type-only, which is what lets it depend on `@projectapp/shared-types` without pulling
 * `zod` in as a runtime dependency.
 */

/** FR-SCH-03. The `dependency_cycle` arm — what `detectCycle` returns when the graph has a loop. */
export type CpmCycleDiagnostic = Extract<CpmDiagnostic, { code: 'dependency_cycle' }>;

/**
 * The `dangling_dependency` arm: an edge naming a task that is not in `tasks`, or a self-link.
 * `cpm.ts` assigns both meanings to this one code — see `buildGraph` for how `missingTaskId` is
 * filled for a self-link, where nothing is actually missing.
 */
export type CpmDanglingDependencyDiagnostic = Extract<
  CpmDiagnostic,
  { code: 'dangling_dependency' }
>;

/**
 * The `unusable_calendar` arm: a calendar with no recurring working time (FR-CAL-01). `cpm.ts`
 * names it "the termination guard for working-time advancement", and `calendar.ts` is where that
 * guard is applied — `compileCalendar` returns this instead of a calendar, so the walk that could
 * not terminate never receives one.
 */
export type CpmUnusableCalendarDiagnostic = Extract<CpmDiagnostic, { code: 'unusable_calendar' }>;
