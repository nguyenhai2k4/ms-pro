# ADR-011: Calendar working hours are interpreted in UTC for MVP

**Status:** Accepted · **Date:** 2026-08-16 · **Phase:** P2 (decided at P2 entry)
**Relates to:** ADR-010 (CPM engine boundary)
**Requirements touched:** FR-CAL-01, FR-CAL-02, FR-SCH-07, FR-TSK-07

## Context

FR-SCH-07 requires duration→date conversion to skip non-working days and hours. The engine
therefore has to answer "is 2026-11-27T14:30Z a working minute?" — and that question has no answer
without a time zone.

The schema does not supply one. `calendar` (migration 0001) stores `working_days smallint[]`,
`working_hours_start_minute` and `working_hours_end_minute`; `calendar_exception` stores a bare
`date`. There is no `timezone` column on either. P0 did not need one because nothing did date
arithmetic; P1's rollup did wall-clock arithmetic only, which is time-zone-free by accident rather
than by design. P2 is the first code that must decide.

Left undecided, this is precisely the ambiguity that gets guessed differently in three places —
the engine, the API's input assembly, and the client's rendering — and produces off-by-one-day
schedules that no unit test catches because every layer agrees with itself.

## Decision

**All calendar minute-of-day values and all `calendar_exception.date` values are interpreted in
UTC.** Weekday derivation (`workingDays`, ISO 1=Monday) is UTC weekday. The engine performs no
time-zone conversion of any kind.

This is written into `packages/shared-types/src/cpm.ts` at the point of use, so an implementer
reading the field sees the rule rather than having to find this ADR.

## Consequences

- **It is a real limitation, not a technicality.** A team in UTC+9 whose calendar says
  09:00–17:00 gets a schedule whose working window is 18:00–02:00 local. For a single-region pilot
  this is invisible; for a distributed customer it is wrong. It is acceptable for MVP and it is
  **not** acceptable indefinitely, so it is recorded as a known limitation rather than discovered
  by a beta customer.
- **The fix is a schema change plus a new ADR, not a code fix.** Per-calendar time zone means a
  `timezone` column on `calendar`, a decision about whether a task's calendar override may differ
  in zone from the project's, and DST handling (a "working day" whose length changes twice a year).
  None of that is P2 scope and pretending otherwise would put a distributed-systems date problem
  inside the phase whose risk is already algorithmic correctness.
- **It keeps the engine deterministic.** Time-zone data is ambient state that changes when the host's
  tzdata is updated — the same input would stop producing the same output across a base-image bump.
  Pinning UTC keeps invariant 1 true without vendoring a tz database into a package that is supposed
  to be pure arithmetic.
- The limitation belongs in the README's known-gaps list and in the beta brief, alongside
  FR-VIEW-01/02 (renderer) and FR-CAL-04 (regional holiday data). Pilot customers should be
  selected knowing it.

## Alternatives rejected

- **Project-level time zone now.** One column, and it looks cheap — but it forces the DST question
  immediately (does an 8-hour task spanning a DST boundary take 8 or 9 wall-clock hours?), and
  getting that wrong is a subtler correctness bug than the one being avoided. It is the right
  answer *after* the engine is proven, not during.
- **Interpret in the requesting user's browser time zone.** The same project would schedule
  differently depending on who triggered the recompute. That is a second source of truth wearing a
  convenience costume, and it breaks invariant 2 outright.
- **Leave it undecided and let the implementation choose.** This is the guessing failure mode
  `docs/MODEL-ROUTING.md` guardrail 3 exists to prevent, and the cost of the guess is silent.
