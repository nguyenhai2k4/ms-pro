# ADR-006: Land the Gantt adapter contract in P0; gate vendor integration behind licensing

**Status:** Accepted · **Date:** 2026-08-15 · **Phase:** P0
**Relates to:** ADR-001 (buy vs. build the Gantt renderer) — **extends, does not supersede**
**Requirements touched:** FR-VIEW-01, FR-VIEW-02, FR-VIEW-03

## Context

ADR-001 decided to license a commercial Gantt component (Bryntum preferred, DHTMLX as the
alternate) for MVP and to keep it behind an internal adapter interface so the renderer can be
swapped later. That decision stands.

It cannot be executed in P0 as written. The commercial components are distributed through
vendor-private npm registries that require license credentials; this repository has neither a
license nor access to those registries. The P0 roadmap line item "Gantt/Grid library
integration (ADR-001)" therefore cannot complete in P0, and the risk-register mitigation
"time-box a spike against both Bryntum and DHTMLX in P0" cannot run either.

Two failure modes were available and both are rejected:

1. **Silently build a different renderer** (in-house canvas, or fork `frappe-gantt`) and call
   the P0 item done. That is a reversal of ADR-001 disguised as an implementation detail, and
   ADR-001 prices the open-source fallback at 6-8 additional weeks concentrated in P1 — far too
   large a commitment to make implicitly.
2. **Block P0** on procurement. The rest of P0 (workspace, CI, schema, auth, org/project shell,
   contracts) does not depend on the renderer and would idle for no benefit.

## Decision

Split the P0 roadmap item into a contract half that lands now and a vendor half that is gated.

1. **The adapter contract lands in P0**, in `packages/shared-types` (`src/gantt.ts`), not in
   `apps/web`. It is a versioned interface contract like the REST and entity types, because it
   is a seam that parallel work collides on. It is expressed purely in ProjectApp domain terms —
   no vendor type appears in it, directly or structurally.
2. **`apps/web` ships exactly one implementation in P0: `PlaceholderGanttAdapter`**, a
   dependency-free DOM/SVG renderer whose stated and only purposes are (a) to prove the contract
   is implementable and complete enough to build view code against, and (b) to unblock P1 UI
   work. It is **not** a candidate MVP renderer, is **not** virtualized, and is **not**
   perf-qualified. It is marked as such in code and excluded from FR-VIEW-02 measurement.
3. **The accessible table representation** (invariant 6 in `CLAUDE.md`, FR-VIEW-03) is built
   against the adapter contract and the shared view-model types — never against the placeholder
   or, later, the vendor. It must survive the vendor swap untouched. This is the concrete
   mechanism that makes "accessibility is built in, not retrofitted" true rather than aspirational.
4. **Vendor selection and integration is a gated deliverable that must complete before P1 exit**,
   because FR-VIEW-01/02 are MVP requirements and every later phase that renders schedule data
   (P2 critical-path highlighting, P3 live deltas, P5 baseline overlay) assumes a real renderer.
   The gate is: license procured → both candidates spiked against this contract → adapter
   implemented under `apps/web/src/gantt/adapter/vendor/` → FR-VIEW-02 perf test green.

## What this ADR explicitly does not decide

- It does not reverse ADR-001. Buy-for-MVP remains the decision.
- It does not adopt an in-house canvas/WebGL renderer.
- It does not adopt ADR-001's open-source fallback (`frappe-gantt` / `svar-gantt`). Choosing that
  path costs 6-8 weeks and requires its own ADR superseding ADR-001, plus a re-planned roadmap.

## Consequences

- **FR-VIEW-01 and FR-VIEW-02 are not satisfied at the end of P0, and P0 must not be reported as
  satisfying them.** Any statement that "the Gantt works" before the gate above closes is false.
- The Gantt paint budget (<1s at 2,000 visible rows) is **unmeasured** until vendor integration.
  The perf harness exists from P0; the number it produces against the placeholder is meaningless
  and is not a baseline.
- Vendor licensing moves onto the P1 critical path. If procurement slips past P1 exit, that is a
  schedule risk to escalate, not to absorb by quietly hardening the placeholder — a placeholder
  that gradually becomes the product is exactly how ADR-001 gets reversed without anyone deciding to.
- A lint rule enforces that no vendor symbol is imported outside `apps/web/src/gantt/adapter/`.
  The rule is added in P0 while the directory is still empty, so it is in place before the first
  vendor import exists.

## Compliance check

The contract is doing its job if, on the day the vendor is integrated, the diff touches
`apps/web/src/gantt/adapter/` and nothing else. If it touches view components, the store, or
`packages/shared-types`, the adapter leaked and ADR-001's exit ramp is not real.
