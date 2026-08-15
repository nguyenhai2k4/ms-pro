# ADR-009: Take the open-source Gantt fallback; supersede ADR-001's buy decision and ADR-008

**Status:** Accepted · **Date:** 2026-08-15 · **Phase:** P1
**Relates to:** ADR-001 (buy vs. build) — **supersedes the buy decision**; ADR-006 (adapter
contract + placeholder) — **the placeholder's exit path changes**; ADR-008 (procure a
commercial license) — **superseded**
**Requirements touched:** FR-VIEW-01, FR-VIEW-02

## Context

ADR-008 recommended procuring a commercial Gantt license (Bryntum preferred) and named that
procurement a hard dependency of P1 exit, explicitly flagging it as a purchase decision outside
engineering agents' reach. Asked directly, the product owner chose the alternative ADR-001
already priced and kept open as a named fallback: fork and harden an open-source Gantt
component instead of buying a license.

This is a real scope decision, not a free substitution. ADR-001 is explicit about the cost:

> If the user/business prefers open-source only: fall back to forking `frappe-gantt` or
> `svar-gantt` and hardening it, but budget 6-8 additional weeks versus the buy path,
> concentrated in M1 — this is the single biggest timeline lever in the whole plan.

## Decision

Take the open-source fallback. Fork and harden **`frappe-gantt`** (the more actively maintained
of the two named candidates, MIT-licensed, no vendor-registry credential requirement — the exact
blocker ADR-006 hit) behind the adapter contract ADR-006 already built. `svar-gantt` is the
documented alternate if `frappe-gantt`'s architecture turns out not to support virtualization to
FR-VIEW-02's 2,000-row target without a rewrite.

The **adapter contract from ADR-006 does not change.** That is the entire point of having built
it as a real boundary rather than an aspirational one: `apps/web/src/gantt/adapter/` swaps its
internals from `PlaceholderGanttAdapter` to a `FrappeGanttAdapter`, and nothing outside that
directory needs to know which rendering library sits behind it.

## Consequences

- **+6-8 weeks, concentrated here, not absorbed silently into P1's 2-week budget.** This is
  large enough that it does not ride along inside the same P1 dispatch as Task/WBS core — it is
  tracked and staffed as its own work item, sequenced in parallel with P1's Task/WBS backend
  work where possible (different files: `apps/web/src/gantt/adapter/` vs. `apps/api/src/routes/`
  and `apps/web`'s task grid), but not pretended to be free.
- **FR-VIEW-01/02 stay formally unmet until this lands**, same as under ADR-008 — the difference
  is the path to closing that gap, not the gap's visibility. The README and roadmap continue to
  say so.
- **The escalation trigger ADR-008 set stays in force, restated for this path**: if
  `frappe-gantt` cannot reach FR-VIEW-02's perf budget (row virtualization to 2,000 visible
  tasks, <1s initial paint) without a rewrite, that is grounds to re-open this decision — escalate
  rather than silently shipping a Gantt view that fails its own NFR. `svar-gantt` is the named
  next attempt before this ADR itself needs superseding.
- **No further licensing spend decision is pending.** ADR-008's "purchase decision outside
  engineering agents' reach" is moot for this path; the remaining work is engineering effort,
  which routes normally under `docs/MODEL-ROUTING.md` (Gantt rendering adapter interface: floor
  S, default O for the interface itself — unchanged from ADR-006).

## What does not change

- ADR-002 (hybrid realtime model), ADR-003 (TypeScript/Node), ADR-004 (`.mpp` deferral), ADR-005
  (leveling heuristic) — untouched, none of them were about the rendering library.
- ADR-006's adapter contract and its accessibility-first design (`CLAUDE.md` invariant 6) —
  unchanged; this ADR only decides what implements it.
