# ProjectApp

Web-native project scheduling and collaboration tool (Gantt/CPM core, real-time
multi-user editing) — a lower-cost, browser-first alternative to MS Project for
mid-market teams.

## Docs

- [`docs/PRD.md`](docs/PRD.md) — Product Requirements Document (source of truth for scope/vision).
- [`docs/FRS.md`](docs/FRS.md) — Functional Requirements Specification: complexity assessment,
  numbered functional requirements, use cases, and persona user journeys.
- [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) — Architecture, technology stack
  decisions (with the PRD's open questions resolved as ADRs), effort/time budget, staffing
  scenarios, and the phased roadmap.
- [`docs/TEAM.md`](docs/TEAM.md) — Development team: agent roster, ownership matrix, phase
  assignments.
- [`docs/MODEL-ROUTING.md`](docs/MODEL-ROUTING.md) — Model tier per task, and the floors that
  can't be overridden.
- [`CLAUDE.md`](CLAUDE.md) — Working agreement: repo layout, locked stack, invariants, conventions.

## Development team

The team is defined as Claude Code subagents in [`.claude/agents/`](.claude/agents) — one
specialist per ownership boundary (`tech-lead`, `scheduler-engineer`, `realtime-engineer`,
`backend-engineer`, `frontend-engineer`, `qa-engineer`, `devops-engineer`).

`tech-lead` orchestrates: it decomposes a phase into waves, routes each work item to the
owning agent at a model tier chosen per [`docs/MODEL-ROUTING.md`](docs/MODEL-ROUTING.md),
dispatches, verifies acceptance, then hands to `qa-engineer`. Hand it a phase:

```
Use the tech-lead agent to decompose and execute P0.
```

See [`docs/TEAM.md`](docs/TEAM.md) for who owns which requirements and phases.

## Getting started

Requires Node 20+ (ADR-003 targets Node 20 LTS; CI pins it) and pnpm 10.

```bash
pnpm install
cp .env.example .env                              # fill in local values
docker compose -f infra/docker-compose.yml up -d  # Postgres, Redis, MinIO
pnpm --filter @projectapp/db migrate              # forward-only migrations
pnpm --filter @projectapp/api dev                 # API on :3001
pnpm --filter @projectapp/web dev                 # SPA on :5173
```

Verification, the same commands CI runs:

```bash
pnpm -r typecheck && pnpm -r lint && pnpm format && pnpm -r test
```

## Status

**P0 (Foundations) — landed. P1 (Task/WBS core) — landed, QA-reviewed.** See
[`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) §6. P2 (Scheduling engine) is next.

P0 landed: pnpm workspace and toolchain, CI, local dev stack, the interface contracts in
`packages/shared-types`, the database schema and migration runner, the API (auth, org/project
shell, RBAC, audit log), and the web shell with the Gantt adapter contract and its accessible
table representation.

P1 landed: the mutation-intent envelope (ADR-007), task/WBS CRUD with the in-process P1 rollup
scheduler (FR-TSK-01..09, FR-TRK-04 partial — see below), calendar CRUD (FR-CAL-01..04, FR-CAL-04
partial — see below), and both surfaces' UI in `apps/web`. Independently QA-reviewed: 352 tests
passing, two real bugs found and fixed in review (a cross-tenant calendar reference that was also
an existence oracle; an unvalidated half-day exception time range), RBAC negative paths and
cross-project id-oracle protection extended to every new endpoint.

Known limitations carried out of P1, tracked rather than silently dropped:

- **FR-TRK-04 is partial.** Duration-weighted % complete rollup works; the "manual override at
  the parent level" half needs a persisted override flag the P0 schema doesn't have, and is
  deferred rather than bolted on ahead of a real UI need for it.
- **FR-CAL-04 is thin.** The `us` and `mon_fri` templates are byte-identical apart from a display
  name — no actual US holiday data ships yet. Pinned as a failing test rather than fixed, because
  which holidays, which observed-date rule, and whether they're seeded per-project or shared
  org-wide are product decisions, not implementation ones.
- **The rollup's per-row query pattern won't hold FR-SCH-06's P2 perf budget** (<500ms @ 5k tasks,
  <150ms incremental) — it does one round trip per ancestor and per renumbered sibling, fine at P1
  scale, not at CPM scale. This is a set-based redesign for `scheduler-engineer` to fold into P2,
  not a P1 patch.
- **No accessibility or cross-browser automation yet** (axe/jest-axe, Playwright e2e) — P1 has
  component-level accessibility tests (labels, roles, no color-only signal) but nothing automated
  against WCAG 2.1 AA end-to-end, and `docs/MODEL-ROUTING.md`/the risk register call for this
  starting P1, not P8.

Also still outstanding from P0, not silently dropped:

- **Gantt renderer** ([`docs/adr/ADR-009`](docs/adr/ADR-009-gantt-open-source-fallback.md)) —
  no commercial license; the decision is now to fork and harden `frappe-gantt` behind the
  ADR-006 adapter contract rather than buy (supersedes ADR-008). A development-only placeholder
  sits behind that contract until the fork lands. **FR-VIEW-01 and FR-VIEW-02 are not
  satisfied.** Budgeted at 6-8 weeks per ADR-001/ADR-009, tracked as its own work item rather
  than inside P1's Task/WBS budget.
- **FR-AUTH-02** (Google/Microsoft OAuth) — the managed provider is not configured; password
  auth only.
- **Email delivery** — password-reset tokens are minted and consumed correctly but not sent.
