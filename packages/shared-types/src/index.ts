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
 * ## What is intentionally absent (P0)
 *
 *  - The `cpm-engine` input graph / output contract — a **P2 entry** deliverable.
 *  - The mutation-intent envelope (ADR-002) and the WebSocket delta format — **P2/P3 entry**.
 *  - Task, dependency, resource, calendar and reporting REST DTOs — **P1 and later**.
 *
 * These are absent on purpose. Nothing in P0 consumes them, and a contract written a phase ahead
 * of its first consumer gets rewritten rather than built against. See `schedule.ts` for the
 * one open question (P1 date-writing path) that decides when the envelope must land.
 */

export const CONTRACT_VERSION = '0.1.0' as const;

export * from './primitives.js';
export * from './enums.js';
export * from './entities.js';
export * from './rbac.js';
export * from './http.js';
export * from './api.js';
export * from './schedule.js';

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
