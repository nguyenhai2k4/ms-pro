# ADR-010: The CPM engine's boundary — pure, synchronous, cache-free, and in-process for P2

**Status:** Accepted · **Date:** 2026-08-16 · **Phase:** P2 (decided at P2 entry)
**Relates to:** ADR-002 (server-authoritative ordered mutations), ADR-007 (P1's in-process
scheduler behind the intent envelope) — **extends, supersedes neither**
**Requirements touched:** FR-SCH-01..08, FR-TSK-03/05/06/07, FR-CAL-01/02

## Context

`packages/cpm-engine` does not exist yet. P2 is its first content, and the shape of its boundary
determines whether `CLAUDE.md` invariant 1 ("the engine is pure; same input → byte-identical
output") is enforced by the compiler or merely asserted in a comment. P0 and P1 deliberately left
this contract unwritten — `schedule.ts` and `index.ts` both say so — because nothing consumed it
until now.

Four questions had to be answered before any parallel P2 work could start, because every one of
them changes what the API, the tests and the frontend build against:

1. How does the engine get calendars, given it may not do I/O?
2. Where does the per-project graph cache live, given `docs/IMPLEMENTATION-PLAN.md` §1 puts one in
   the Scheduler Service and that service does not exist?
3. Does P2 create `apps/scheduler` as a separate process?
4. Where do the derived ES/EF/LS/LF/float values get stored?

## Decision

**1. The engine's public functions are synchronous.**
`ComputeSchedule`, `RecomputeSchedule` and `DetectCycle` in
`packages/shared-types/src/cpm.ts` all return values, never promises. A function that cannot
return a promise cannot await a query, so "no DB calls, no network" becomes a type error rather
than a code-review finding. This is the cheapest available enforcement of invariant 1 and it is
why the signatures live in the shared contract instead of in the implementation.

**2. Calendars are resolved by the caller into `CpmScheduleInput.calendars`.**
The engine never dereferences a calendar id. It receives every calendar the graph references, with
exceptions inlined. A referenced calendar that is absent is a `missing_calendar` **error
diagnostic**, not a lookup and not a throw.

**3. Incremental recompute takes the previous result as an argument; the engine holds no cache.**
`RecomputeSchedule({ input, previous, dirty })` where `input` is the *complete post-mutation
graph*. A module-level cache inside a pure package is state, and state is exactly how "same input →
same output" stops being true. The per-project in-memory graph described in §1 of the plan belongs
to the **caller**: `apps/api` in P2, the Scheduler Service in P3.

The result is a **whole schedule**, not a patch — untouched tasks are carried over from `previous`
verbatim — with a separate `changedTaskIds` list. This makes the phase's highest-yield invariant a
literal deep equality that can be property-tested on random graphs:

```
recomputeSchedule({ input, previous, dirty }).result  ===  computeSchedule(input)
```

A patch-shaped result would have made that invariant expressible only through a reconstruction
step, and a bug in the reconstruction would have hidden a bug in the engine.

**4. FR-SCH-06's 150ms incremental budget is measured at the engine boundary in P2.**
Request in, result out. Loading 5,000 task rows out of Postgres to assemble `input` is *not* inside
that budget and will not fit inside it — which is precisely why the plan puts an in-memory
per-project graph in the Scheduler Service. That service is P3. P2 therefore meets FR-SCH-06 at the
engine boundary and **says so in the phase report**; the end-to-end HTTP number is a P3/P8
measurement. Reporting FR-SCH-06 as met end-to-end on P2 evidence would be reporting the wrong
number, and the risk register already flags this budget as the one most likely to slip.

**5. P2 does not create `apps/scheduler`.**
The engine is a pure package called in-process from `apps/api`, behind `applyTaskIntent` — the same
single write path ADR-007 established, unchanged for callers. Splitting the process is P3 work,
driven by the realtime hub's need for a stateful per-project owner, and doing it in P2 would add a
deployment surface and an RPC contract to the phase whose risk is *algorithmic correctness*. The
intent envelope is already shaped to cross a process boundary later without touching callers, which
is the whole reason ADR-007 built it that way.

**6. Derived schedule values go in an engine-owned `task_schedule` table, not on `task`.**
`start`, `finish` and `duration_hours` stay task columns with their existing write path.
ES/EF/LS/LF/`total_float_hours`/`is_critical`/`has_schedule_conflict` land in a new one-row-per-task
table written only by the recompute path (migration 0003). `schedule.ts` already stated the reason:
modelling float as a task column invites someone to `PATCH` it, and float that can be set by hand
is not float. A separate table makes that structural, and gives the read endpoint
(`GET /projects/:id/schedule`) an obvious shape with no PATCH counterpart.

**7. A cycle rejects the whole computation; there is no partial result.**
`CpmScheduleResult` is a discriminated union on `status`, and the `rejected` arm has no
`taskSchedules` field at all — a half-applied recompute is not representable. FR-SCH-03's "clear
error identifying the cycle" is carried as `cyclePath` plus `cycleDependencyIds`, surfaced through
the `dependency_cycle` error code and `details.cyclePath` field that `http.ts` reserved in P0.
`DetectCycle` is exposed separately so the dependency-create endpoint can reject before it writes,
without paying for a full schedule to answer a yes/no question.

## Consequences

- The engine cannot be given "just one more lookup" without an interface change, which is the
  point. Any computation needing data not in `CpmScheduleInput` escalates to `tech-lead`
  (invariant 7) rather than growing an I/O path.
- `apps/api` becomes responsible for assembling the input graph and for holding whatever cache it
  needs. In P2 that is per-request; it will not hold FR-SCH-06 end-to-end, and that is stated
  rather than papered over.
- `apps/api/src/scheduler/rollup.ts`'s wall-clock date arithmetic and its per-row query pattern are
  **retired** in this phase, not patched — the risk register calls the per-row pattern out by name
  as unable to hold the budget at CPM scale. The rollup's `applyTaskIntent` entry point and audit
  change-set survive; its arithmetic does not.
- Auditing (invariant 4) stays per-task-that-actually-moved, driven by `changedTaskIds`. A single
  edit that legitimately moves 5,000 tasks still writes 5,000 audit rows; that is correct but must
  be a single set-based insert, not 5,000 round trips. Whether audit volume itself needs a
  summary-row design is a **P6 question**, flagged here, not decided here.

## What does not change

- ADR-002's hybrid realtime model and ADR-007's single write path: intents in, one writer, no
  CRDT for schedule data. P2 widens the intent vocabulary with dependency intents; it does not
  change the envelope's role.
- ADR-005 (leveling heuristic) and ADR-009 (open-source Gantt): untouched. Neither is about the
  engine's boundary.

## Alternatives rejected

- **Async engine signatures "for flexibility."** Flexibility to do what? The only thing an async
  signature enables here is I/O, which is the one thing invariant 1 forbids.
- **A patch-shaped incremental result.** Smaller payload, but it costs the deep-equality property
  that is the single best defence against the silent-correctness failure this phase exists to
  avoid. Wrong trade at this risk level.
- **Standing up `apps/scheduler` now.** Adds a process, an RPC contract and a deployment story to
  the phase whose risk is algorithmic. P3 needs the split for its own reasons and will do it
  against a stable engine — which is the standing judgment that keeps P2 and P3 sequential.
- **Derived columns on `task`.** Fewer joins, but it reopens exactly the "float you can PATCH"
  hole P0 wrote a paragraph to close.
