# ADR-008: Procure a commercial Gantt license; ADR-006's placeholder is time-boxed to P1

**Status:** Accepted · **Date:** 2026-08-15 · **Phase:** P1
**Relates to:** ADR-001 (buy vs. build) — **confirms**; ADR-006 (adapter contract + placeholder) — **closes its gate**
**Requirements touched:** FR-VIEW-01, FR-VIEW-02

## Context

ADR-006 split P0's "Gantt/Grid library integration" into a contract half that landed and a
vendor half that could not, because the commercial components ship through vendor-private npm
registries requiring license credentials this repository does not have. It left the choice open
and named the exit gate.

The consequence carried into P1: **FR-VIEW-01 and FR-VIEW-02 are unmet.** A
`PlaceholderGanttAdapter` sits behind the adapter contract declaring
`virtualizedRows: false, perfQualified: false`, with a tripwire test asserting both stay false.
The perf budget in FR-VIEW-02 (<1s paint at 2,000 visible rows) has never been measured because
there is nothing capable of being measured.

The P0 tech-lead flagged the specific failure mode: absent a decision, the placeholder gets
incrementally hardened until ADR-001 has been reversed without anyone deciding to reverse it.

## Decision

**Procure a commercial license** (Bryntum preferred per ADR-001; DHTMLX the alternate), and
treat vendor integration as on the P1 critical path.

The open-source fallback in ADR-001 — forking `frappe-gantt` or `svar-gantt` — is explicitly
**not** taken. ADR-001 prices it at 6-8 additional weeks concentrated in P1, and nothing has
changed to make that trade better than the ~$1-2k/dev licence cost.

The placeholder is **time-boxed to P1**. It is a development-only stand-in, not a fallback
position.

## Consequences

- Procurement is a purchase decision outside the engineering agents' reach and is now a hard
  dependency of P1 exit. It should be started immediately rather than at the point of need.
- The adapter contract from ADR-006 is what makes this a bounded integration rather than a
  rewrite: app code speaks our types, vendor specifics stay inside
  `apps/web/src/gantt/adapter/`, and the ESLint vendor-import block enforces the boundary.
  ADR-001 budgets ~2-3 weeks for integration on this basis.
- FR-VIEW-01/02 stay formally unmet until integration lands. The README, roadmap, and ADR-006
  all say so, and none of them should be softened while it is still true.

## The escalation trigger, stated concretely

If licensing is not resolved by P1 exit, **escalate — do not absorb it by hardening the
placeholder.** Hardening is the disguised reversal ADR-006 warned about. The legitimate
responses are: extend the P1 gate with an explicit new date, or write a superseding ADR taking
ADR-001's open-source fallback with its 6-8 week cost stated openly and re-planned into the
roadmap.

QA's P0 review noted the ADR-006 tripwire guards a self-declaration — it catches someone
flipping the capability flags, not someone quietly making the placeholder better while the
flags stay false. It has since been widened with a behavioural check. That widening is a
detector, not a substitute for this decision.
