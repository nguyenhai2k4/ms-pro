# ADR-007: P1 writes task dates through an in-process scheduler behind the intent envelope

**Status:** Accepted · **Date:** 2026-08-15 · **Phase:** P1 (decided at P0 exit)
**Relates to:** ADR-002 (server-authoritative ordered mutations) — **implements, does not supersede**
**Requirements touched:** FR-TSK-01, FR-TSK-03, FR-TSK-05, FR-SCH-04, FR-COL-02

## Context

P1 delivers task CRUD and WBS rollup. Both write task dates. But the Scheduler Service does
not exist until P2, and `backend-engineer`'s standing brief says the API never computes
schedules — it forwards intents and persists the scheduler's authoritative output.

P0 surfaced this as an unresolved fork rather than guessing at it. `packages/shared-types`
deliberately did **not** land the cpm-engine I/O contract, the mutation-intent envelope, or the
WebSocket delta format, on the reasoning that a contract written a phase before its first
consumer gets rewritten rather than built against. That reasoning holds for the delta format
and the engine contract. It does not survive P1 for the intent envelope, because P1 is now the
envelope's first consumer.

Three options were considered:

1. **API writes dates directly in P1, refactor at P2.** Fastest through P1, and rejected. It
   creates exactly the second source of truth ADR-002 exists to prevent, converts every
   date-writing call site into P2 rework, and — the real risk — shortcuts of this shape tend to
   become permanent because the refactor never has its own budget line.
2. **P1 ships structure only, no dates.** Zero rework and the smallest P1, but P1 would exit
   without a schedule that can be demoed or dogfooded, which strands the tracking and view work
   that follows it.
3. **Minimal in-process scheduler behind the eventual intent interface.** Chosen.

## Decision

The **mutation-intent envelope lands at P1 entry**, one phase earlier than originally planned,
and P1 ships a minimal in-process scheduler behind it.

- The API continues to never compute or write dates itself. It sends intents; something
  authoritative answers. In P1 that something runs in-process; in P2 it becomes the Scheduler
  Service. Callers do not change.
- There is one source of truth for dates at every point in the project's life. ADR-002's
  invariant is never temporarily suspended.
- The in-process implementation is deliberately minimal — enough for P1's rollup semantics, not
  a preview of the CPM engine. `packages/cpm-engine` remains empty and `scheduler-engineer`'s
  P2 scope is unchanged.

The cpm-engine I/O contract and the WebSocket delta format still do **not** land at P1. Their
first consumers are P2 and P3 respectively, and the original reasoning still applies to them.

## Consequences

- P1 entry gains a contract-definition task (tier O, floor O — interface work under
  `docs/MODEL-ROUTING.md`) that was previously budgeted to P2. P2 loses it.
- P2's scheduler work becomes a substitution behind a stable interface rather than a migration
  of call sites, which is the cheaper shape and the reason for accepting the earlier contract.
- Risk accepted: an intent envelope designed against P1's needs may need widening for P2's real
  scheduler. This is bounded — the envelope describes *what the user asked for*, not what the
  engine computes, and P1's intents (create/update/move/reparent a task) are a subset of P2's.
  If widening turns out to be structural rather than additive, that warrants a superseding ADR.

## Open question deliberately not closed here

Whether the in-process scheduler runs the single-writer per-project queue from ADR-002 in P1,
or whether ordering is deferred to P3 when concurrent editors first exist. P1 has one writer per
request and no realtime clients, so the queue has nothing to serialize yet. `tech-lead` should
decide this at P1 entry with the envelope, not in advance of it.
