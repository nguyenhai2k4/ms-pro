/**
 * `@projectapp/shared-types` — the versioned interface contracts between packages.
 *
 * This package is where parallel work collides, so it is owned by `tech-lead` and changes to it
 * are reviewed as interface changes, not as edits (docs/MODEL-ROUTING.md: tier O, floor O).
 *
 * ## Contract versioning
 *
 * `CONTRACT_VERSION` is the version of the *shape* of these types, independent of the package
 * version. Bump it when a change would break a consumer that has not been redeployed:
 *
 *  - **Breaking** (major): removing or renaming a field, narrowing a type, adding a required
 *    field, removing an enum member, changing the meaning of an existing field.
 *  - **Additive** (minor): a new optional field, a new enum member consumers may ignore, a new
 *    schema or endpoint DTO.
 *
 * `apps/api`, `apps/web` and `apps/scheduler` all pin the same workspace version, so a breaking
 * change is a single coordinated commit rather than a negotiation between services. That is the
 * point of the monorepo, and it stops being true the moment something reads these types over a
 * network boundary without a version check.
 *
 * ## What landed at P2 entry
 *
 *  - `cpm.ts` — the `cpm-engine` input graph, result envelope and incremental-recompute
 *    request/result (ADR-010), plus the engine's function signatures. The contract `schedule.ts`
 *    and this file both named as deliberately absent since P0.
 *  - Dependency intents in `intents.ts` and dependency + computed-schedule REST DTOs in `api.ts`.
 *
 * ## What is intentionally still absent (as of P2 entry)
 *
 *  - **The WebSocket delta format** — a **P3 entry** deliverable (FR-COL-01..04, ADR-002).
 *    `CpmIncrementalResult.changedTaskIds` is the engine's "what moved"; wrapping it in a
 *    sequenced, ack'd, presence-carrying wire message is a different contract with different
 *    failure modes, and P2 opens no sockets.
 *  - **Resource, baseline, reporting and import REST DTOs** — P4 and later.
 *  - **Backward scheduling from a deadline** — FR-SCH-09 tags it P2 in the FRS's *product-phase*
 *    sense, which is not the P2 roadmap phase. `CpmScheduleDirection` leaves room for it without
 *    pretending to have it.
 *
 * These are absent on purpose. Nothing before their owning phase consumes them, and a contract
 * written a phase ahead of its first consumer gets rewritten rather than built against.
 *
 * The mutation-intent envelope (ADR-002) landed at P1 entry rather than P2/P3 as originally
 * scoped — see ADR-007 (`docs/adr/`) and `intents.ts` for why: P1's task CRUD needed a single
 * write path for schedule fields (invariant 2) a phase before the standalone Scheduler Service
 * exists, so the envelope is what `apps/api`'s in-process P1 scheduler is built against instead.
 */

/**
 * 0.4.0 — **breaking**: `mutationIntentEnvelopeSchema.intent` is rebound from `taskIntentSchema`
 * to `scheduleIntentSchema`, so the envelope now carries seven intent kinds rather than four. The
 * type of an existing field widened, which is why this is a major-shaped bump and not an additive
 * one: every consumer that switches on `envelope.intent.kind` must handle `createDependency`,
 * `updateDependency` and `deleteDependency` or stop compiling. That failure is the point — it is
 * how a new intent cannot reach a writer that has no case for it. Landed with the handler that
 * satisfies it (P2 work item W2-2): `apps/api/src/routes/dependencies.ts` and the dependency arm
 * of `apps/api/src/scheduler/rollup.ts`, whose entry point is renamed `applyTaskIntent` ->
 * `applyScheduleIntent` in the same commit.
 *
 * 0.3.0 — additive: `cpm.ts` in full, dependency intents, dependency and schedule DTOs. No
 * existing field changed meaning, so a consumer that ignores the new exports still compiles.
 */
export const CONTRACT_VERSION = '0.4.0' as const;

export * from './primitives.js';
export * from './enums.js';
export * from './entities.js';
export * from './rbac.js';
export * from './http.js';
export * from './api.js';
export * from './schedule.js';
export * from './cpm.js';
export * from './intents.js';

/**
 * The Gantt rendering contract is **not** re-exported here. It is client-only and it references
 * DOM types; `apps/api` and `apps/scheduler` have no business seeing it, and pulling `lib.dom`
 * into a Node service to satisfy an import it never uses is how server code ends up touching
 * `document`. Import it explicitly:
 *
 * ```ts
 * import type { GanttAdapter, GanttViewModel } from '@projectapp/shared-types/gantt';
 * ```
 */
